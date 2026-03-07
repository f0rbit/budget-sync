import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { type Result, err, ok, try_catch, try_catch_async } from "@f0rbit/corpus";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type {
	AiParseResultSnapshot,
	ComputationSnapshot,
	RawDocumentSnapshot,
	SyncResultSnapshot,
} from "../corpus/schemas.js";
import type { AppContext } from "../db/client.js";
import { syncRuns } from "../db/schema.js";
import type { DbError, PipelineError, ProviderError } from "../errors.js";
import { errors } from "../errors.js";
import { type PipelineContext, categorizeAll } from "../pipeline/categorizer.js";
import { loadMappings } from "../pipeline/local-mappings.js";
import type { AccountType, DocumentParser, MerchantMappings, RawTransaction, SyncStatus } from "../providers/types.js";
import { findAccountByExternalId, upsertAccount } from "./account-service.js";
import { getCurrentNetWorth } from "./networth-service.js";
import { createTransaction } from "./transaction-service.js";

// === Types ===

export interface IngestOptions {
	accountName?: string;
	accountType?: AccountType;
	institution?: string;
	dateFrom?: string;
	dateTo?: string;
	dryRun?: boolean;
	verbose?: boolean;
	mappings?: MerchantMappings;
}

export interface IngestSummary {
	syncRunId: string;
	parser: string;
	documentHash: string;
	accountName: string;
	transactionsCreated: number;
	transactionsExcluded: number;
	transactionsSkipped: number;
	snapshotsUpserted: number;
	netWorth?: number;
	status: SyncStatus;
	duration: number;
	errors: string[];
	notes: string[];
}

type IngestError = ProviderError | DbError | PipelineError;

// === Helpers ===

function detectMimeType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	const mimeMap: Record<string, string> = {
		".pdf": "application/pdf",
		".csv": "text/csv",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".txt": "text/plain",
		".json": "application/json",
	};
	return mimeMap[ext] ?? "text/plain";
}

function isBinaryMime(mimeType: string): boolean {
	return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

async function updateSyncRunStatus(
	ctx: AppContext,
	syncRunId: string,
	status: "failed" | "partial",
	errorMessage: string,
): Promise<void> {
	await try_catch_async(
		async () => {
			ctx.db
				.update(syncRuns)
				.set({
					finishedAt: new Date(),
					status,
					errorMessage,
				})
				.where(eq(syncRuns.id, syncRunId))
				.run();
		},
		() => errors.dbError("Failed to update sync run status"),
	);
}

// === Main Ingest Function ===

export async function ingestDocument(
	ctx: AppContext,
	parser: DocumentParser,
	filePath: string,
	config: AppConfig,
	options?: IngestOptions,
): Promise<Result<IngestSummary, IngestError>> {
	const startTime = Date.now();
	const syncRunId = createId();
	const now = new Date().toISOString();
	const summaryNotes: string[] = [];
	const summaryErrors: string[] = [];

	// Step 1: Read document from disk
	const mimeType = detectMimeType(filePath);
	const isBinary = isBinaryMime(mimeType);

	const readResult = try_catch(
		() => readFileSync(filePath),
		(e) => errors.parseError(`Failed to read file: ${e}`),
	);
	if (!readResult.ok) return readResult;

	const rawBuffer = readResult.value;
	const content = isBinary ? rawBuffer.toString("base64") : rawBuffer.toString("utf-8");

	// Step 2: Compute content hash
	const contentHash = createHash("sha256").update(rawBuffer).digest("hex");

	// Step 3: Store full document in corpus ["raw-documents"]
	const docSnapshot: RawDocumentSnapshot = {
		filename: basename(filePath),
		mimeType,
		contentHash,
		sizeBytes: rawBuffer.length,
		ingestedAt: now,
		content,
		isBase64: isBinary,
	};
	const docResult = await ctx.corpus.stores["raw-documents"].put(docSnapshot, {
		tags: [`file:${basename(filePath)}`, `type:${mimeType}`],
	});
	const docVersion = docResult.ok ? docResult.value.version : undefined;

	// Step 4: Create sync_runs record
	const syncRunResult = await try_catch_async(
		async () =>
			ctx.db
				.insert(syncRuns)
				.values({
					id: syncRunId,
					provider: parser.name,
					status: "success",
				})
				.returning()
				.get(),
		(e) => errors.dbError(`Failed to create sync run: ${e}`, e),
	);
	if (!syncRunResult.ok) return syncRunResult;

	// Step 5: Parse document
	const accountHint =
		options?.accountName || options?.accountType
			? { accountName: options.accountName, accountType: options.accountType }
			: undefined;

	const parseResult = await parser.parse(content, mimeType, accountHint);
	if (!parseResult.ok) {
		await updateSyncRunStatus(ctx, syncRunId, "failed", parseResult.error.message);
		return parseResult;
	}

	const parsed = parseResult.value;
	if (parsed.notes?.length) {
		summaryNotes.push(...parsed.notes);
	}

	// Step 6: Store AI parse result in corpus ["ai-parse-results"]
	const parseSnapshot: AiParseResultSnapshot = {
		parser: parser.name,
		model: undefined,
		parsedAt: now,
		transactions: parsed.transactions,
		account: parsed.account,
		notes: parsed.notes,
		rawResponse: parsed.rawResponse,
	};
	const parseStoreResult = await ctx.corpus.stores["ai-parse-results"].put(parseSnapshot, {
		parents: docVersion ? [{ store_id: "raw-documents", version: docVersion }] : [],
		tags: [`parser:${parser.name}`],
	});
	const parseVersion = parseStoreResult.ok ? parseStoreResult.value.version : undefined;

	// Step 7: Filter by date range
	let filteredTransactions = parsed.transactions;
	if (options?.dateFrom) {
		const from = options.dateFrom;
		filteredTransactions = filteredTransactions.filter((tx) => tx.transactionDate >= from);
	}
	if (options?.dateTo) {
		const to = options.dateTo;
		filteredTransactions = filteredTransactions.filter((tx) => tx.transactionDate <= to);
	}

	const dateFiltered = parsed.transactions.length - filteredTransactions.length;
	if (dateFiltered > 0) {
		summaryNotes.push(`${dateFiltered} transactions filtered by date range`);
	}

	// Step 8: Create/find account
	const accountName = options?.accountName ?? parsed.account?.name ?? "Unknown Import";
	const institution = options?.institution ?? parsed.account?.institution ?? "Unknown";
	const accountType = options?.accountType ?? parsed.account?.type ?? "transaction";

	const accountResult = await upsertAccount(ctx.db, parser.name, {
		id: `${parser.name}:${accountName}`,
		name: accountName,
		institution,
		type: accountType,
	});
	if (!accountResult.ok) {
		await updateSyncRunStatus(ctx, syncRunId, "failed", accountResult.error.message);
		return accountResult;
	}

	const account = accountResult.value;

	// Step 9: Update accountId on all transactions
	const transactions: RawTransaction[] = filteredTransactions.map((tx) => ({
		...tx,
		accountId: account.externalId ?? `${parser.name}:${accountName}`,
	}));

	// Step 10: Run categorization pipeline
	let mappings: MerchantMappings;
	if (options?.mappings) {
		mappings = options.mappings;
	} else {
		const mappingsResult = loadMappings();
		if (!mappingsResult.ok) {
			await updateSyncRunStatus(ctx, syncRunId, "failed", mappingsResult.error.message);
			return mappingsResult;
		}
		mappings = mappingsResult.value;
	}

	const pipelineContext: PipelineContext = {
		mappings,
		rentConfig: config.rent,
	};

	const { categorized, excluded } = await categorizeAll(transactions, pipelineContext);

	// Step 11: Store sync results in corpus ["sync-results"]
	const syncResultSnapshot: SyncResultSnapshot = {
		syncRunId,
		provider: parser.name,
		processedAt: now,
		categorized,
		excluded,
		stats: {
			totalFetched: parsed.transactions.length,
			categorized: categorized.length,
			excluded: excluded.length,
			duplicatesSkipped: 0,
		},
	};

	const syncResultStoreResult = await ctx.corpus.stores["sync-results"].put(syncResultSnapshot, {
		parents: parseVersion ? [{ store_id: "ai-parse-results", version: parseVersion }] : [],
		tags: [`sync-run:${syncRunId}`, `parser:${parser.name}`],
	});
	const syncResultVersion = syncResultStoreResult.ok ? syncResultStoreResult.value.version : undefined;

	// Step 12: Materialize into SQLite (skip in dry-run)
	let transactionsCreated = 0;
	let transactionsSkipped = 0;

	if (!options?.dryRun) {
		for (const tx of categorized) {
			const txAccountResult = await findAccountByExternalId(ctx.db, parser.name, tx.accountId);
			if (!txAccountResult.ok || !txAccountResult.value) continue;

			const insertResult = await createTransaction(ctx.db, txAccountResult.value.id, tx, syncRunId);
			if (insertResult.ok) {
				transactionsCreated++;
			} else if (insertResult.error.code === "DUPLICATE") {
				transactionsSkipped++;
			}
		}
	} else {
		summaryNotes.push("Dry run — no transactions materialized");
	}

	// Step 13: Update sync_runs record with counts
	await try_catch_async(
		async () => {
			ctx.db
				.update(syncRuns)
				.set({
					finishedAt: new Date(),
					status: "success" as const,
					transactionsCreated,
					transactionsExcluded: excluded.length,
					transactionsSkipped,
					snapshotsCreated: 0,
				})
				.where(eq(syncRuns.id, syncRunId))
				.run();
		},
		(e) => errors.dbError(`Failed to update sync run: ${e}`, e),
	);

	// Step 14: Compute net worth and store computation snapshot
	let netWorth: number | undefined;

	const netWorthResult = await getCurrentNetWorth(ctx.db);
	if (netWorthResult.ok) {
		const breakdown = netWorthResult.value;
		netWorth = breakdown.netWorth;

		const computationSnapshot: ComputationSnapshot = {
			ingestRunId: syncRunId,
			computedAt: now,
			netWorth: {
				total: breakdown.netWorth,
				transaction: breakdown.components.transaction,
				savings: breakdown.components.savings,
				credit: breakdown.components.credit,
				super: breakdown.components.super,
			},
			accountBalances: breakdown.accounts.map((a) => ({
				accountId: a.id,
				accountName: a.name,
				accountType: a.type,
				balance: a.balance,
			})),
			materialization: {
				transactionsCreated,
				transactionsExcluded: excluded.length,
				transactionsSkipped,
				snapshotsUpserted: 0,
			},
		};

		await ctx.corpus.stores["computation-snapshots"].put(computationSnapshot, {
			parents: syncResultVersion ? [{ store_id: "sync-results", version: syncResultVersion }] : [],
			tags: [`sync-run:${syncRunId}`, `parser:${parser.name}`],
		});
	}

	// Return IngestSummary
	return ok({
		syncRunId,
		parser: parser.name,
		documentHash: contentHash,
		accountName,
		transactionsCreated,
		transactionsExcluded: excluded.length,
		transactionsSkipped,
		snapshotsUpserted: 0,
		netWorth,
		status: "success" as SyncStatus,
		duration: Date.now() - startTime,
		errors: summaryErrors,
		notes: summaryNotes,
	});
}

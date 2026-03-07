import { type Result, err, ok, try_catch_async } from "@f0rbit/corpus";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type {
	RawAccountsSnapshot,
	RawBalancesSnapshot,
	RawTransactionsSnapshot,
	SyncResultSnapshot,
} from "../corpus/schemas.js";
import type { AppContext } from "../db/client.js";
import { syncRuns } from "../db/schema.js";
import type { DbError, PipelineError, ProviderError } from "../errors.js";
import { errors } from "../errors.js";
import { type PipelineContext, categorizeAll } from "../pipeline/categorizer.js";
import { loadMappings } from "../pipeline/local-mappings.js";
import type { BankProvider, DateRange, RawTransaction, SyncSummary } from "../providers/types.js";
import { findAccountByExternalId, listAccounts, upsertAccount } from "./account-service.js";
import { upsertSnapshot } from "./snapshot-service.js";
import { createTransaction } from "./transaction-service.js";

// === Types ===

export interface SyncOptions {
	dateFrom?: string;
	dateTo?: string;
	dryRun?: boolean;
	accountId?: string;
	verbose?: boolean;
}

type SyncError = ProviderError | DbError | PipelineError;

// === Main Sync Function ===

export async function syncTransactions(
	ctx: AppContext,
	provider: BankProvider,
	config: AppConfig,
	options?: SyncOptions,
): Promise<Result<SyncSummary, SyncError>> {
	const startTime = Date.now();
	const syncRunId = createId();
	const now = new Date().toISOString();

	const today = new Date().toISOString().slice(0, 10);
	const defaultFrom = new Date(Date.now() - config.sync.default_range_days * 86400000).toISOString().slice(0, 10);
	const dateRange: DateRange = {
		from: options?.dateFrom ?? defaultFrom,
		to: options?.dateTo ?? today,
	};

	// Step 1: Create sync_run record
	const syncRunResult = await try_catch_async(
		async () =>
			ctx.db
				.insert(syncRuns)
				.values({
					id: syncRunId,
					provider: provider.name,
					status: "success",
				})
				.returning()
				.get(),
		(e) => errors.dbError(`Failed to create sync run: ${e}`, e),
	);
	if (!syncRunResult.ok) return syncRunResult;

	// Step 2: Authenticate
	const authResult = await provider.authenticate();
	if (!authResult.ok) {
		await updateSyncRunStatus(ctx, syncRunId, "failed", authResult.error.message);
		return authResult;
	}

	// Step 3: Discover accounts → snapshot to corpus
	const accountsResult = await provider.getAccounts();
	if (!accountsResult.ok) {
		await updateSyncRunStatus(ctx, syncRunId, "failed", accountsResult.error.message);
		return accountsResult;
	}

	const accountsSnapshot: RawAccountsSnapshot = {
		provider: provider.name,
		fetchedAt: now,
		accounts: accountsResult.value,
	};
	await ctx.corpus.stores["raw-accounts"].put(accountsSnapshot, {
		tags: [`provider:${provider.name}`],
	});

	// Upsert accounts into DB (non-fatal on failure)
	for (const info of accountsResult.value) {
		const upsertResult = await upsertAccount(ctx.db, provider.name, info);
		if (!upsertResult.ok && options?.verbose) {
			console.warn(`Failed to upsert account ${info.id}: ${upsertResult.error.message}`);
		}
	}

	// Step 4: Fetch transactions per account
	const activeAccountsResult = await listAccounts(ctx.db);
	if (!activeAccountsResult.ok) {
		await updateSyncRunStatus(ctx, syncRunId, "failed", activeAccountsResult.error.message);
		return activeAccountsResult;
	}

	let accountsToSync = activeAccountsResult.value;
	if (options?.accountId) {
		accountsToSync = accountsToSync.filter((a) => a.id === options.accountId || a.externalId === options.accountId);
	}

	const allRawTransactions: RawTransaction[] = [];
	const rawSnapshotVersions: string[] = [];

	for (const account of accountsToSync) {
		if (!account.externalId) continue;

		const txResult = await provider.fetchTransactions(account.externalId, dateRange);
		if (!txResult.ok) {
			if (options?.verbose) {
				console.warn(`Failed to fetch transactions for ${account.name}: ${txResult.error.message}`);
			}
			continue;
		}

		const txSnapshot: RawTransactionsSnapshot = {
			accountId: account.externalId,
			provider: provider.name,
			dateRange,
			fetchedAt: now,
			transactions: txResult.value,
		};
		const snapshotResult = await ctx.corpus.stores["raw-transactions"].put(txSnapshot, {
			tags: [`account:${account.externalId}`, `provider:${provider.name}`, `date:${today}`],
		});
		if (snapshotResult.ok) {
			rawSnapshotVersions.push(snapshotResult.value.version);
		}

		allRawTransactions.push(...txResult.value);
	}

	// Step 5: Fetch balances → snapshot to corpus (non-fatal)
	const balancesResult = await provider.getAccountBalances();
	if (balancesResult.ok && balancesResult.value.length > 0) {
		const balancesSnapshot: RawBalancesSnapshot = {
			provider: provider.name,
			fetchedAt: now,
			balances: balancesResult.value,
		};
		await ctx.corpus.stores["raw-balances"].put(balancesSnapshot, {
			tags: [`provider:${provider.name}`, `date:${today}`],
		});
	}

	// Step 5.5: Materialize balances to snapshots table (non-fatal, gated by auto_snapshot)
	let snapshotsMaterialized = 0;
	if (config.sync.auto_snapshot && balancesResult.ok) {
		for (const bal of balancesResult.value) {
			const accountResult = await findAccountByExternalId(ctx.db, provider.name, bal.accountId);
			if (!accountResult.ok || !accountResult.value) continue;

			const snapshotResult = await upsertSnapshot(ctx.db, {
				accountId: accountResult.value.id,
				date: bal.asOf,
				balance: bal.balance,
				available: bal.available,
				syncRunId,
			});
			if (snapshotResult.ok) snapshotsMaterialized++;
		}
	}

	// Step 6: Run categorization pipeline
	const mappingsResult = loadMappings();
	if (!mappingsResult.ok) {
		await updateSyncRunStatus(ctx, syncRunId, "failed", mappingsResult.error.message);
		return mappingsResult;
	}

	const enrich = provider.enrichTransaction;
	const pipelineContext: PipelineContext = {
		mappings: mappingsResult.value,
		rentConfig: config.rent,
		enrichTransaction: enrich ? (desc: string) => enrich(desc) : undefined,
	};

	const { categorized, excluded } = await categorizeAll(allRawTransactions, pipelineContext);

	// Step 7: Snapshot sync results to corpus with parent lineage
	const syncResultSnapshot: SyncResultSnapshot = {
		syncRunId,
		provider: provider.name,
		processedAt: now,
		categorized,
		excluded,
		stats: {
			totalFetched: allRawTransactions.length,
			categorized: categorized.length,
			excluded: excluded.length,
			duplicatesSkipped: 0,
		},
	};

	await ctx.corpus.stores["sync-results"].put(syncResultSnapshot, {
		parents: rawSnapshotVersions.map((version) => ({
			store_id: "raw-transactions",
			version,
		})),
		tags: [`sync-run:${syncRunId}`, `provider:${provider.name}`],
	});

	// Step 8: Materialize into SQLite (skip in dry-run)
	let transactionsCreated = 0;
	let transactionsSkipped = 0;

	if (!options?.dryRun) {
		for (const tx of categorized) {
			const accountResult = await findAccountByExternalId(ctx.db, provider.name, tx.accountId);
			if (!accountResult.ok || !accountResult.value) continue;

			const insertResult = await createTransaction(ctx.db, accountResult.value.id, tx, syncRunId);
			if (insertResult.ok) {
				transactionsCreated++;
			} else if (insertResult.error.code === "DUPLICATE") {
				transactionsSkipped++;
			}
		}
	}

	// Step 9: Update sync_run with counts
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
					snapshotsCreated: snapshotsMaterialized,
				})
				.where(eq(syncRuns.id, syncRunId))
				.run();
		},
		(e) => errors.dbError(`Failed to update sync run: ${e}`, e),
	);

	// Step 10: Return summary
	return ok({
		syncRunId,
		provider: provider.name,
		accountsSynced: accountsToSync.length,
		transactionsCreated,
		transactionsExcluded: excluded.length,
		transactionsSkipped,
		snapshotsCreated: rawSnapshotVersions.length + 1 + snapshotsMaterialized,
		status: "success" as const,
		duration: Date.now() - startTime,
		errors: [],
	});
}

// === Helpers ===

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

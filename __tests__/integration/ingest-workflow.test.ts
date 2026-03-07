import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.js";
import type { AppContext } from "../../src/db/client.js";
import { accounts, syncRuns, transactions } from "../../src/db/schema.js";
import type { InMemoryDocumentParser } from "../../src/providers/in-memory/document-parser.js";
import { upsertAccount } from "../../src/services/account-service.js";
import { type IngestOptions, ingestDocument } from "../../src/services/ingest-service.js";
import { upsertSnapshot } from "../../src/services/snapshot-service.js";
import {
	createTestContext,
	createTestDocumentParser,
	makeConfig,
	makeParsedDocument,
	makeTransaction,
} from "../helpers.js";

// --- Shared fixtures ---

const CSV_CONTENT = "Date,Description,Amount\n2026-03-01,WOOLWORTHS,42.50\n2026-03-02,MCDONALDS,15.00\n";

function writeTempFile(dir: string, filename: string, content: string): string {
	const filePath = join(dir, filename);
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

describe("ingest-workflow", () => {
	let ctx: AppContext;
	let config: AppConfig;
	let parser: InMemoryDocumentParser;
	let tmpDir: string;
	let filePath: string;

	beforeEach(() => {
		ctx = createTestContext();
		config = makeConfig();
		parser = createTestDocumentParser({ defaultResult: makeParsedDocument() });
		tmpDir = mkdtempSync(join(tmpdir(), "ingest-test-"));
		filePath = writeTempFile(tmpDir, "statement.csv", CSV_CONTENT);
	});

	it("I1: full ingest creates correct DB records", async () => {
		const result = await ingestDocument(ctx, parser, filePath, config);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.transactionsCreated).toBeGreaterThan(0);
		expect(result.value.status).toBe("success");
		expect(result.value.parser).toBe("in-memory-parser");

		const dbAccounts = ctx.db.select().from(accounts).all();
		expect(dbAccounts.length).toBe(1);
		expect(dbAccounts[0]?.name).toBe("Everyday Account");

		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(result.value.transactionsCreated);
	});

	it("I2: full ingest creates corpus snapshots", async () => {
		const result = await ingestDocument(ctx, parser, filePath, config);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// raw-documents store
		const rawDoc = await ctx.corpus.stores["raw-documents"].get_latest();
		expect(rawDoc.ok).toBe(true);
		if (rawDoc.ok) {
			expect(rawDoc.value.data.filename).toBe("statement.csv");
			expect(rawDoc.value.data.mimeType).toBe("text/csv");
		}

		// ai-parse-results store
		const parseResult = await ctx.corpus.stores["ai-parse-results"].get_latest();
		expect(parseResult.ok).toBe(true);
		if (parseResult.ok) {
			expect(parseResult.value.data.parser).toBe("in-memory-parser");
			expect(parseResult.value.data.transactions.length).toBe(2);
		}

		// sync-results store
		const syncResult = await ctx.corpus.stores["sync-results"].get_latest();
		expect(syncResult.ok).toBe(true);
		if (syncResult.ok) {
			expect(syncResult.value.data.syncRunId).toBeTruthy();
			expect(syncResult.value.data.stats.totalFetched).toBe(2);
		}

		// computation-snapshots store
		const compResult = await ctx.corpus.stores["computation-snapshots"].get_latest();
		expect(compResult.ok).toBe(true);
		if (compResult.ok) {
			expect(compResult.value.data.ingestRunId).toBeTruthy();
			expect(compResult.value.data.netWorth).toBeDefined();
		}
	});

	it("I3: duplicate prevention via external_id", async () => {
		const result1 = await ingestDocument(ctx, parser, filePath, config);
		expect(result1.ok).toBe(true);
		if (!result1.ok) return;
		const firstCount = result1.value.transactionsCreated;
		expect(firstCount).toBeGreaterThan(0);

		// Second ingest with same parser result (same external IDs)
		const result2 = await ingestDocument(ctx, parser, filePath, config);
		expect(result2.ok).toBe(true);
		if (!result2.ok) return;

		expect(result2.value.transactionsCreated).toBe(0);
		expect(result2.value.transactionsSkipped).toBeGreaterThan(0);

		// DB should have same count as after first ingest
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(firstCount);
	});

	it("I4: dry-run creates corpus snapshots but no DB transactions", async () => {
		const options: IngestOptions = { dryRun: true };
		const result = await ingestDocument(ctx, parser, filePath, config, options);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.transactionsCreated).toBe(0);

		// DB transactions table should be empty
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(0);

		// Corpus stores should still have snapshots
		const rawDoc = await ctx.corpus.stores["raw-documents"].get_latest();
		expect(rawDoc.ok).toBe(true);

		const parseResult = await ctx.corpus.stores["ai-parse-results"].get_latest();
		expect(parseResult.ok).toBe(true);

		const syncResult = await ctx.corpus.stores["sync-results"].get_latest();
		expect(syncResult.ok).toBe(true);
	});

	it("I5: parser failure returns Result.err without crash", async () => {
		parser.failNextParse = true;
		const result = await ingestDocument(ctx, parser, filePath, config);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("API_ERROR");

		// sync_runs record should be marked failed
		const syncRunRows = ctx.db.select().from(syncRuns).all();
		expect(syncRunRows.length).toBe(1);
		expect(syncRunRows[0]?.status).toBe("failed");
	});

	it("I6: date range filtering", async () => {
		const wideRangeDoc = makeParsedDocument({
			transactions: [
				makeTransaction({
					id: "tx-jan",
					description: "WOOLWORTHS JAN",
					amount: 20,
					direction: "debit",
					transactionDate: "2026-01-15",
					postDate: "2026-01-15",
					accountId: "pending",
				}),
				makeTransaction({
					id: "tx-feb",
					description: "WOOLWORTHS FEB",
					amount: 30,
					direction: "debit",
					transactionDate: "2026-02-10",
					postDate: "2026-02-10",
					accountId: "pending",
				}),
				makeTransaction({
					id: "tx-mar",
					description: "WOOLWORTHS MAR",
					amount: 40,
					direction: "debit",
					transactionDate: "2026-03-05",
					postDate: "2026-03-05",
					accountId: "pending",
				}),
			],
		});
		parser.setDefaultResult(wideRangeDoc);

		const options: IngestOptions = { dateFrom: "2026-03-01" };
		const result = await ingestDocument(ctx, parser, filePath, config, options);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Only March transaction should be materialized
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(1);
		expect(dbTxs[0]?.date).toBe("2026-03-05");
	});

	it("I7: account inference from parser", async () => {
		const doc = makeParsedDocument({
			account: { name: "My Savings", institution: "CommBank", type: "savings" },
		});
		parser.setDefaultResult(doc);

		const result = await ingestDocument(ctx, parser, filePath, config);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.accountName).toBe("My Savings");

		const dbAccounts = ctx.db.select().from(accounts).all();
		expect(dbAccounts.length).toBe(1);
		expect(dbAccounts[0]?.name).toBe("My Savings");
		expect(dbAccounts[0]?.institution).toBe("CommBank");
		expect(dbAccounts[0]?.type).toBe("savings");
	});

	it("I8: account override with options", async () => {
		const doc = makeParsedDocument({
			account: { name: "AI Inferred", institution: "AI Bank", type: "transaction" },
		});
		parser.setDefaultResult(doc);

		const options: IngestOptions = {
			accountName: "Override Account",
			institution: "Real Bank",
			accountType: "savings",
		};
		const result = await ingestDocument(ctx, parser, filePath, config, options);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.accountName).toBe("Override Account");

		const dbAccounts = ctx.db.select().from(accounts).all();
		expect(dbAccounts.length).toBe(1);
		expect(dbAccounts[0]?.name).toBe("Override Account");
		expect(dbAccounts[0]?.institution).toBe("Real Bank");
		expect(dbAccounts[0]?.type).toBe("savings");
	});

	it("I9: document content stored in corpus", async () => {
		const knownContent = "known,test,content\nrow1,a,b\nrow2,c,d\n";
		const testFile = writeTempFile(tmpDir, "known.csv", knownContent);

		const result = await ingestDocument(ctx, parser, testFile, config);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rawDoc = await ctx.corpus.stores["raw-documents"].get_latest();
		expect(rawDoc.ok).toBe(true);
		if (!rawDoc.ok) return;

		expect(rawDoc.value.data.content).toBe(knownContent);
		expect(rawDoc.value.data.isBase64).toBe(false);
		expect(rawDoc.value.data.filename).toBe("known.csv");

		const expectedHash = createHash("sha256").update(knownContent).digest("hex");
		expect(rawDoc.value.data.contentHash).toBe(expectedHash);
		expect(result.value.documentHash).toBe(expectedHash);
	});

	it("I10: computation snapshot captures net worth", async () => {
		// Set up a pre-existing savings account with a snapshot
		const savingsResult = await upsertAccount(ctx.db, "manual", {
			id: "savings-ext-1",
			name: "Savings Account",
			institution: "BankSA",
			type: "savings",
		});
		expect(savingsResult.ok).toBe(true);
		if (!savingsResult.ok) return;

		const snapResult = await upsertSnapshot(ctx.db, {
			accountId: savingsResult.value.id,
			date: "2026-03-01",
			balance: 10000,
		});
		expect(snapResult.ok).toBe(true);

		// Now ingest a document (creates a transaction account)
		const result = await ingestDocument(ctx, parser, filePath, config);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// computation-snapshots should include the existing savings balance
		const compResult = await ctx.corpus.stores["computation-snapshots"].get_latest();
		expect(compResult.ok).toBe(true);
		if (!compResult.ok) return;

		expect(compResult.value.data.netWorth.savings).toBe(10000);
		expect(compResult.value.data.netWorth.total).toBeGreaterThanOrEqual(10000);

		// Should list both accounts in the breakdown
		const accountNames = compResult.value.data.accountBalances.map((a: { accountName: string }) => a.accountName);
		expect(accountNames).toContain("Savings Account");
	});
});

import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.js";
import type { AppContext } from "../../src/db/client.js";
import { accounts, syncRuns, transactions } from "../../src/db/schema.js";
import type { InMemoryDocumentParser } from "../../src/providers/in-memory/document-parser.js";
import type { MerchantMappings } from "../../src/providers/types.js";
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

	it("I11: cross-account dedup excludes savings duplicate", async () => {
		const testMappings: MerchantMappings = {
			mappings: [{ match: "OFFICEWORKS", item: "Officeworks", category: "Shopping" }],
			exclusions: [],
		};

		// First ingest: credit card statement with Officeworks $42.50
		const ccDoc = makeParsedDocument({
			transactions: [
				makeTransaction({
					id: "cc-officeworks",
					description: "OFFICEWORKS BRISBANE",
					amount: 42.5,
					direction: "debit",
					transactionDate: "2026-02-28",
					postDate: "2026-02-28",
					accountId: "pending",
				}),
			],
			account: { name: "Amplify Platinum", institution: "Amplify", type: "credit" },
		});

		const ccParser = createTestDocumentParser({ defaultResult: ccDoc });
		const result1 = await ingestDocument(ctx, ccParser, filePath, config, { mappings: testMappings });
		expect(result1.ok).toBe(true);
		if (!result1.ok) return;
		expect(result1.value.transactionsCreated).toBe(1);

		// Second ingest: savings statement with same Officeworks $42.50 (2 days later)
		const savingsDoc = makeParsedDocument({
			transactions: [
				makeTransaction({
					id: "sav-officeworks",
					description: "Officeworks Pty Ltd Brisbane OFFICEWORKS",
					amount: 42.5,
					direction: "debit",
					transactionDate: "2026-03-02",
					postDate: "2026-03-02",
					accountId: "pending",
				}),
			],
			account: { name: "BankSA Savings", institution: "BankSA", type: "savings" },
		});

		const savParser = createTestDocumentParser({ defaultResult: savingsDoc });
		const result2 = await ingestDocument(ctx, savParser, filePath, config, { mappings: testMappings });
		expect(result2.ok).toBe(true);
		if (!result2.ok) return;

		// The savings duplicate should have been detected
		expect(result2.value.transactionsDeduplicated).toBe(1);
		expect(result2.value.transactionsCreated).toBe(0);

		// DB should have only 1 transaction (the credit card one)
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(1);
		expect(dbTxs[0]?.rawDescription).toContain("OFFICEWORKS");
	});

	it("I12: cross-account dedup respects item mismatch", async () => {
		const testMappings: MerchantMappings = {
			mappings: [
				{ match: "UBER \\*ONE MEMBERSHIP", item: "Uber One", category: "Subscriptions" },
				{ match: "AMZNPRIMEA", item: "Amazon Prime", category: "Subscriptions" },
			],
			exclusions: [],
		};

		// First ingest: credit card with Uber One $9.99
		const ccDoc = makeParsedDocument({
			transactions: [
				makeTransaction({
					id: "cc-uber",
					description: "UBER *ONE MEMBERSHIP",
					amount: 9.99,
					direction: "debit",
					transactionDate: "2026-02-28",
					postDate: "2026-02-28",
					accountId: "pending",
				}),
			],
			account: { name: "Amplify Platinum", institution: "Amplify", type: "credit" },
		});

		const ccParser = createTestDocumentParser({ defaultResult: ccDoc });
		const result1 = await ingestDocument(ctx, ccParser, filePath, config, { mappings: testMappings });
		expect(result1.ok).toBe(true);
		if (!result1.ok) return;

		// Second ingest: savings with Amazon Prime $9.99 (different item, same amount)
		const savingsDoc = makeParsedDocument({
			transactions: [
				makeTransaction({
					id: "sav-amazon",
					description: "AMZNPRIMEA MEMBERSHIP",
					amount: 9.99,
					direction: "debit",
					transactionDate: "2026-03-02",
					postDate: "2026-03-02",
					accountId: "pending",
				}),
			],
			account: { name: "BankSA Savings", institution: "BankSA", type: "savings" },
		});

		const savParser = createTestDocumentParser({ defaultResult: savingsDoc });
		const result2 = await ingestDocument(ctx, savParser, filePath, config, { mappings: testMappings });
		expect(result2.ok).toBe(true);
		if (!result2.ok) return;

		// No dedup — different items
		expect(result2.value.transactionsDeduplicated).toBe(0);
		expect(result2.value.transactionsCreated).toBe(1);

		// DB has both
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(2);
	});

	it("I13: cross-account dedup ignores same-account transactions", async () => {
		const testMappings: MerchantMappings = {
			mappings: [{ match: "WOOLWORTHS", item: "Woolworths", category: "Woolworths" }],
			exclusions: [],
		};

		// First ingest from BankSA Everyday
		const doc1 = makeParsedDocument({
			transactions: [
				makeTransaction({
					id: "tx-a",
					description: "WOOLWORTHS 1234",
					amount: 50.0,
					direction: "debit",
					transactionDate: "2026-03-01",
					postDate: "2026-03-01",
					accountId: "pending",
				}),
			],
			account: { name: "BankSA Everyday", institution: "BankSA", type: "transaction" },
		});

		const parser1 = createTestDocumentParser({ defaultResult: doc1 });
		const result1 = await ingestDocument(ctx, parser1, filePath, config, { mappings: testMappings });
		expect(result1.ok).toBe(true);
		if (!result1.ok) return;
		expect(result1.value.transactionsCreated).toBe(1);

		// Second ingest from SAME account
		const doc2 = makeParsedDocument({
			transactions: [
				makeTransaction({
					id: "tx-b",
					description: "WOOLWORTHS 5678",
					amount: 50.0,
					direction: "debit",
					transactionDate: "2026-03-02",
					postDate: "2026-03-02",
					accountId: "pending",
				}),
			],
			account: { name: "BankSA Everyday", institution: "BankSA", type: "transaction" },
		});

		const parser2 = createTestDocumentParser({ defaultResult: doc2 });
		const result2 = await ingestDocument(ctx, parser2, filePath, config, { mappings: testMappings });
		expect(result2.ok).toBe(true);
		if (!result2.ok) return;

		// No dedup — same account
		expect(result2.value.transactionsDeduplicated).toBe(0);
		expect(result2.value.transactionsCreated).toBe(1);

		// DB has both
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(2);
	});
});

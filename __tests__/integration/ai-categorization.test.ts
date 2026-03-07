import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.js";
import type { AppContext } from "../../src/db/client.js";
import { transactions } from "../../src/db/schema.js";
import { type PipelineContext, categorizeAll, categorizePipeline } from "../../src/pipeline/categorizer.js";
import { appendMappings, loadMappings } from "../../src/pipeline/local-mappings.js";
import type { InMemoryAiCategorizer } from "../../src/providers/in-memory/categorizer.js";
import type { InMemoryDocumentParser } from "../../src/providers/in-memory/document-parser.js";
import type { MerchantMappings, RawTransaction } from "../../src/providers/types.js";
import { type IngestOptions, ingestDocument } from "../../src/services/ingest-service.js";
import {
	createTestAiCategorizer,
	createTestContext,
	createTestDocumentParser,
	makeConfig,
	makeParsedDocument,
	makeRentConfig,
	makeTransaction,
} from "../helpers.js";

// --- Shared helpers ---

function tx(overrides: Partial<RawTransaction> & { id: string; description: string }): RawTransaction {
	return {
		amount: 25.0,
		direction: "debit",
		transactionDate: "2026-03-05",
		postDate: "2026-03-05",
		accountId: "acc-1",
		...overrides,
	};
}

function writeTempMappings(dir: string, overrides?: Partial<{ mappings: unknown[]; exclusions: unknown[] }>): string {
	const mappingsPath = join(dir, "merchant-mappings.jsonc");
	const content = {
		// Comment preservation tested via JSONC format
		mappings: overrides?.mappings ?? [
			{ match: "WOOLWORTHS", item: "Woolworths", category: "Woolworths" },
			{ match: "MCDONALDS", item: "McDonald's", category: "Eating Out" },
		],
		exclusions: overrides?.exclusions ?? [{ match: "To 460184", reason: "Credit card payment" }],
	};
	writeFileSync(mappingsPath, JSON.stringify(content, null, 2));
	return mappingsPath;
}

function writeTempFile(dir: string, filename: string, content: string): string {
	const filePath = join(dir, filename);
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

const CSV_CONTENT = "Date,Description,Amount\n2026-03-01,TEST,42.50\n";

describe("AI categorization integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ai-cat-test-"));
	});

	describe("full pipeline with AI categorization", () => {
		it("known merchants use local mappings, unknowns upgraded by AI", async () => {
			const mappingsPath = writeTempMappings(tmpDir);
			const mappingsResult = loadMappings(mappingsPath);
			expect(mappingsResult.ok).toBe(true);
			if (!mappingsResult.ok) return;

			const categorizer = createTestAiCategorizer();
			categorizer.setResult("tx-cafe", "Random Cafe", "Eating Out", "AI identified as cafe");

			const context: PipelineContext = {
				mappings: mappingsResult.value,
				rentConfig: makeRentConfig(),
				aiCategorizer: categorizer,
			};

			const rawTxs: RawTransaction[] = [
				tx({ id: "tx-woolies", description: "WOOLWORTHS 1234 ADELAIDE SA" }),
				tx({ id: "tx-mcd", description: "MCDONALDS SOUTH BRISBANE" }),
				tx({ id: "tx-cafe", description: "RANDOM CAFE BRISBANE", amount: 12 }),
			];

			const { categorized, excluded } = await categorizeAll(rawTxs, context);

			// Known merchants categorized by local mappings
			const woolies = categorized.find((t) => t.externalId === "tx-woolies");
			expect(woolies).toBeDefined();
			expect(woolies?.category).toBe("Woolworths");
			expect(woolies?.item).toBe("Woolworths");

			const mcd = categorized.find((t) => t.externalId === "tx-mcd");
			expect(mcd).toBeDefined();
			expect(mcd?.category).toBe("Eating Out");
			expect(mcd?.item).toBe("McDonald's");

			// Unknown merchant upgraded from "Other" to AI category
			const cafe = categorized.find((t) => t.externalId === "tx-cafe");
			expect(cafe).toBeDefined();
			expect(cafe?.category).toBe("Eating Out");
			expect(cafe?.item).toBe("Random Cafe");
			expect(cafe?.notes).toBe("AI identified as cafe");

			// AI should only have received the uncategorized transaction
			expect(categorizer.calls.length).toBe(1);
			expect(categorizer.calls[0]?.uncategorized.length).toBe(1);
			expect(categorizer.calls[0]?.uncategorized[0]?.externalId).toBe("tx-cafe");

			expect(excluded.length).toBe(0);
		});
	});

	describe("AI suggests mappings written to temp file", () => {
		it("new patterns appear in the JSONC file", async () => {
			const mappingsPath = writeTempMappings(tmpDir);

			const categorizer = createTestAiCategorizer();
			categorizer.setSuggestedMappings([
				{ match: "RANDOM CAFE", item: "Random Cafe", category: "Eating Out" },
				{ match: "FANCY BAR", item: "Fancy Bar", category: "Alcohol" },
			]);

			const mappingsResult = loadMappings(mappingsPath);
			expect(mappingsResult.ok).toBe(true);
			if (!mappingsResult.ok) return;

			const context: PipelineContext = {
				mappings: mappingsResult.value,
				rentConfig: makeRentConfig(),
				aiCategorizer: categorizer,
			};

			const rawTxs: RawTransaction[] = [
				tx({ id: "tx-cafe", description: "RANDOM CAFE BRISBANE" }),
				tx({ id: "tx-bar", description: "FANCY BAR FORTITUDE VALLEY" }),
			];

			const result = await categorizeAll(rawTxs, context);
			expect(result.aiCategorizationResult).toBeDefined();

			// Write suggested mappings to temp file
			if (!result.aiCategorizationResult) return;
			const writeResult = appendMappings(result.aiCategorizationResult.suggestedMappings, mappingsPath);
			expect(writeResult.ok).toBe(true);
			if (!writeResult.ok) return;
			expect(writeResult.value).toBe(2);

			// Verify file contains new patterns
			const updatedContent = readFileSync(mappingsPath, "utf-8");
			expect(updatedContent).toContain("RANDOM CAFE");
			expect(updatedContent).toContain("FANCY BAR");

			// Verify original mappings still present
			expect(updatedContent).toContain("WOOLWORTHS");
			expect(updatedContent).toContain("MCDONALDS");
		});
	});

	describe("second pass hits new mapping (no AI call)", () => {
		it("previously-unknown transactions match via local mapping on second pass", async () => {
			const mappingsPath = writeTempMappings(tmpDir);

			// First pass: AI categorizes unknowns
			const categorizer = createTestAiCategorizer();
			categorizer.setResult("tx-cafe", "Random Cafe", "Eating Out");
			categorizer.setSuggestedMappings([{ match: "RANDOM CAFE", item: "Random Cafe", category: "Eating Out" }]);

			const mappingsResult1 = loadMappings(mappingsPath);
			expect(mappingsResult1.ok).toBe(true);
			if (!mappingsResult1.ok) return;

			const context1: PipelineContext = {
				mappings: mappingsResult1.value,
				rentConfig: makeRentConfig(),
				aiCategorizer: categorizer,
			};

			const rawTxs: RawTransaction[] = [tx({ id: "tx-cafe", description: "RANDOM CAFE BRISBANE" })];

			const result1 = await categorizeAll(rawTxs, context1);
			expect(result1.aiCategorizationResult).toBeDefined();
			expect(categorizer.calls.length).toBe(1);

			// Write suggested mappings
			if (!result1.aiCategorizationResult) return;
			const writeResult = appendMappings(result1.aiCategorizationResult.suggestedMappings, mappingsPath);
			expect(writeResult.ok).toBe(true);

			// Second pass: reload mappings, run WITHOUT AI
			const mappingsResult2 = loadMappings(mappingsPath);
			expect(mappingsResult2.ok).toBe(true);
			if (!mappingsResult2.ok) return;

			const context2: PipelineContext = {
				mappings: mappingsResult2.value,
				rentConfig: makeRentConfig(),
				// No aiCategorizer — should match via local mapping now
			};

			const result2 = await categorizeAll(rawTxs, context2);

			// Transaction should be categorized by local mapping
			const cafe = result2.categorized.find((t) => t.externalId === "tx-cafe");
			expect(cafe).toBeDefined();
			expect(cafe?.category).toBe("Eating Out");
			expect(cafe?.item).toBe("Random Cafe");

			// AI was NOT called on second pass
			expect(categorizer.calls.length).toBe(1); // still 1 from first pass
		});
	});

	describe("AI failure is non-fatal", () => {
		it("transactions stay as Other when AI fails", async () => {
			const mappingsPath = writeTempMappings(tmpDir);
			const mappingsResult = loadMappings(mappingsPath);
			expect(mappingsResult.ok).toBe(true);
			if (!mappingsResult.ok) return;

			const categorizer = createTestAiCategorizer();
			categorizer.failNext = true;

			const context: PipelineContext = {
				mappings: mappingsResult.value,
				rentConfig: makeRentConfig(),
				aiCategorizer: categorizer,
			};

			const rawTxs: RawTransaction[] = [
				tx({ id: "tx-known", description: "WOOLWORTHS SOMEWHERE" }),
				tx({ id: "tx-unknown", description: "TOTALLY UNKNOWN STORE" }),
			];

			const { categorized, excluded } = await categorizeAll(rawTxs, context);

			// Known merchant still categorized correctly
			const woolies = categorized.find((t) => t.externalId === "tx-known");
			expect(woolies?.category).toBe("Woolworths");

			// Unknown merchant stays as "Other" — no error thrown
			const unknown = categorized.find((t) => t.externalId === "tx-unknown");
			expect(unknown?.category).toBe("Other");
			expect(unknown?.item).toBe("TOTALLY UNKNOWN STORE");

			expect(excluded.length).toBe(0);
			expect(categorizer.calls.length).toBe(1);
		});
	});

	describe("CSV through unified ingest pipeline with AI", () => {
		let ctx: AppContext;
		let config: AppConfig;
		let parser: InMemoryDocumentParser;

		beforeEach(() => {
			ctx = createTestContext();
			config = makeConfig();
		});

		it("AI categorizer is called during ingest and DB has AI-assigned categories", async () => {
			const doc = makeParsedDocument({
				transactions: [
					makeTransaction({
						id: "parsed-known",
						description: "MCDONALDS SOUTH BRISBANE",
						amount: 15,
						direction: "debit",
						transactionDate: "2026-03-01",
						postDate: "2026-03-01",
						accountId: "pending",
					}),
					makeTransaction({
						id: "parsed-unknown",
						description: "MYSTERIOUS SHOP WEST END",
						amount: 42,
						direction: "debit",
						transactionDate: "2026-03-02",
						postDate: "2026-03-02",
						accountId: "pending",
					}),
				],
			});
			parser = createTestDocumentParser({ defaultResult: doc });

			const categorizer = createTestAiCategorizer();
			categorizer.setResult("parsed-unknown", "Mysterious Shop", "Shopping", "Looks like retail");

			const filePath = writeTempFile(tmpDir, "statement.csv", CSV_CONTENT);
			const testMappings = {
				mappings: [{ match: "MCDONALDS", item: "McDonald's", category: "Eating Out" as const }],
				exclusions: [],
			};
			const options: IngestOptions = { aiCategorizer: categorizer, mappings: testMappings };

			const result = await ingestDocument(ctx, parser, filePath, config, options);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			// AI categorizer was called
			expect(categorizer.calls.length).toBe(1);
			expect(categorizer.calls[0]?.uncategorized.length).toBe(1);
			expect(categorizer.calls[0]?.uncategorized[0]?.externalId).toBe("parsed-unknown");

			// DB transactions have AI-assigned categories
			const dbTxs = ctx.db.select().from(transactions).all();
			expect(dbTxs.length).toBe(2);

			const dbUnknown = dbTxs.find((t) => t.externalId === "parsed-unknown");
			expect(dbUnknown).toBeDefined();
			expect(dbUnknown?.category).toBe("Shopping");
			expect(dbUnknown?.item).toBe("Mysterious Shop");

			const dbKnown = dbTxs.find((t) => t.externalId === "parsed-known");
			expect(dbKnown).toBeDefined();
			expect(dbKnown?.category).toBe("Eating Out");
		});
	});

	describe("corpus lineage — AI results stored", () => {
		let ctx: AppContext;
		let config: AppConfig;
		let parser: InMemoryDocumentParser;

		beforeEach(() => {
			ctx = createTestContext();
			config = makeConfig();
		});

		it("ai-categorization-results corpus store has a snapshot after ingest with AI", async () => {
			const doc = makeParsedDocument({
				transactions: [
					makeTransaction({
						id: "corpus-tx",
						description: "UNKNOWN PLACE BRISBANE",
						amount: 30,
						direction: "debit",
						transactionDate: "2026-03-01",
						postDate: "2026-03-01",
						accountId: "pending",
					}),
				],
			});
			parser = createTestDocumentParser({ defaultResult: doc });

			const categorizer = createTestAiCategorizer();
			categorizer.setResult("corpus-tx", "Unknown Place", "Entertainment", "Event venue");

			const filePath = writeTempFile(tmpDir, "statement.csv", CSV_CONTENT);
			const testMappings = { mappings: [], exclusions: [] };
			const options: IngestOptions = { aiCategorizer: categorizer, mappings: testMappings };

			const result = await ingestDocument(ctx, parser, filePath, config, options);
			expect(result.ok).toBe(true);

			// Check corpus store
			const catResult = await ctx.corpus.stores["ai-categorization-results"].get_latest();
			expect(catResult.ok).toBe(true);
			if (!catResult.ok) return;

			const snapshot = catResult.value.data;
			expect(snapshot.categorizer).toBe("in-memory-categorizer");
			expect(snapshot.result.categorizations.length).toBe(1);
			expect(snapshot.result.categorizations[0]?.externalId).toBe("corpus-tx");
			expect(snapshot.result.categorizations[0]?.category).toBe("Entertainment");
			expect(snapshot.result.categorizations[0]?.item).toBe("Unknown Place");
			expect(snapshot.result.suggestedMappings.length).toBeGreaterThan(0);
		});
	});

	describe("dry run skips mapping writes", () => {
		let ctx: AppContext;
		let config: AppConfig;
		let parser: InMemoryDocumentParser;

		beforeEach(() => {
			ctx = createTestContext();
			config = makeConfig();
		});

		it("AI categorizes and corpus snapshot created, but no DB transactions", async () => {
			const doc = makeParsedDocument({
				transactions: [
					makeTransaction({
						id: "dry-tx",
						description: "DRY RUN SHOP",
						amount: 20,
						direction: "debit",
						transactionDate: "2026-03-01",
						postDate: "2026-03-01",
						accountId: "pending",
					}),
				],
			});
			parser = createTestDocumentParser({ defaultResult: doc });

			const categorizer = createTestAiCategorizer();
			categorizer.setResult("dry-tx", "Dry Run Shop", "Shopping");

			const filePath = writeTempFile(tmpDir, "statement.csv", CSV_CONTENT);
			const testMappings = { mappings: [], exclusions: [] };
			const options: IngestOptions = { dryRun: true, aiCategorizer: categorizer, mappings: testMappings };

			const result = await ingestDocument(ctx, parser, filePath, config, options);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			// AI was called
			expect(categorizer.calls.length).toBe(1);

			// Corpus snapshot created
			const catResult = await ctx.corpus.stores["ai-categorization-results"].get_latest();
			expect(catResult.ok).toBe(true);

			// No transactions in DB (dry run)
			const dbTxs = ctx.db.select().from(transactions).all();
			expect(dbTxs.length).toBe(0);
			expect(result.value.transactionsCreated).toBe(0);
		});
	});

	describe("batch context — AI receives surrounding categorized transactions", () => {
		it("categorizer.calls context contains already-categorized transactions (not Other)", async () => {
			const mappingsPath = writeTempMappings(tmpDir);
			const mappingsResult = loadMappings(mappingsPath);
			expect(mappingsResult.ok).toBe(true);
			if (!mappingsResult.ok) return;

			const categorizer = createTestAiCategorizer();
			categorizer.setDefaultCategory("Shopping");

			const context: PipelineContext = {
				mappings: mappingsResult.value,
				rentConfig: makeRentConfig(),
				aiCategorizer: categorizer,
			};

			const rawTxs: RawTransaction[] = [
				tx({ id: "tx-woolies", description: "WOOLWORTHS BRISBANE", amount: 85 }),
				tx({ id: "tx-mcd", description: "MCDONALDS CITY", amount: 12 }),
				tx({ id: "tx-unknown1", description: "MYSTERY PLACE ONE", amount: 30 }),
				tx({ id: "tx-unknown2", description: "MYSTERY PLACE TWO", amount: 45 }),
			];

			await categorizeAll(rawTxs, context);

			expect(categorizer.calls.length).toBe(1);
			const call = categorizer.calls[0];
			if (!call) return;

			// Uncategorized should only contain the unknowns
			expect(call.uncategorized.length).toBe(2);
			const uncatIds = call.uncategorized.map((u) => u.externalId);
			expect(uncatIds).toContain("tx-unknown1");
			expect(uncatIds).toContain("tx-unknown2");

			// Context should contain the already-categorized ones (Woolworths, McDonald's)
			const contextItems = call.context.categorizedTransactions.map((c) => c.item);
			expect(contextItems).toContain("Woolworths");
			expect(contextItems).toContain("McDonald's");

			// Context should NOT contain "Other" items
			const contextCategories = call.context.categorizedTransactions.map((c) => c.category);
			for (const cat of contextCategories) {
				expect(cat).not.toBe("Other");
			}
		});
	});

	describe("fixed exclusion patterns match real CSV descriptions", () => {
		it("Internet Withdrawal prefix does not prevent exclusion matching", async () => {
			const realMappingsResult = loadMappings();
			expect(realMappingsResult.ok).toBe(true);
			if (!realMappingsResult.ok) return;

			const context: PipelineContext = {
				mappings: realMappingsResult.value,
				rentConfig: makeRentConfig(),
			};

			const raw = tx({
				id: "tx-ccpay",
				description: "Internet Withdrawal 04Mar09:39 To 460184 Credit Card Payment",
				amount: 500,
				direction: "debit",
			});

			const result = await categorizePipeline(raw, context);

			expect(result.type).toBe("excluded");
			if (result.type !== "excluded") return;
			expect(result.transaction.reason).toBe("Credit card payment");
		});

		it("savings transfer with Internet Withdrawal prefix is also excluded", async () => {
			const realMappingsResult = loadMappings();
			expect(realMappingsResult.ok).toBe(true);
			if (!realMappingsResult.ok) return;

			const context: PipelineContext = {
				mappings: realMappingsResult.value,
				rentConfig: makeRentConfig(),
			};

			const raw = tx({
				id: "tx-savings",
				description: "Internet Withdrawal 05Mar14:22 To 131007 Savings Goal",
				amount: 200,
				direction: "debit",
			});

			const result = await categorizePipeline(raw, context);

			expect(result.type).toBe("excluded");
			if (result.type !== "excluded") return;
			expect(result.transaction.reason).toBe("Savings transfer");
		});
	});
});

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.js";
import type { AppContext } from "../../src/db/client.js";
import type { InMemoryDocumentParser } from "../../src/providers/in-memory/document-parser.js";
import { ingestDocument } from "../../src/services/ingest-service.js";
import {
	createTestContext,
	createTestDocumentParser,
	makeConfig,
	makeParsedDocument,
	makeTransaction,
} from "../helpers.js";

describe("corpus lineage", () => {
	let ctx: AppContext;
	let config: AppConfig;
	let parser: InMemoryDocumentParser;
	let tmpDir: string;
	let filePath: string;

	beforeEach(() => {
		ctx = createTestContext();
		config = makeConfig();
		parser = createTestDocumentParser({
			defaultResult: makeParsedDocument({
				transactions: [
					makeTransaction({
						id: "tx-1",
						description: "MCDONALDS BRISBANE",
						amount: 15,
						direction: "debit",
						transactionDate: "2026-03-05",
						postDate: "2026-03-05",
						accountId: "pending",
					}),
					makeTransaction({
						id: "tx-2",
						description: "WOOLWORTHS/5678 MELBOURNE",
						amount: 85,
						direction: "debit",
						transactionDate: "2026-03-06",
						postDate: "2026-03-06",
						accountId: "pending",
					}),
				],
			}),
		});
		tmpDir = mkdtempSync(join(tmpdir(), "lineage-test-"));
		filePath = join(tmpDir, "statement.csv");
		writeFileSync(filePath, "test,data\n");
	});

	it("raw-documents store has snapshot after ingest", async () => {
		await ingestDocument(ctx, parser, filePath, config);

		const latest = await ctx.corpus.stores["raw-documents"].get_latest();
		expect(latest.ok).toBe(true);
		if (!latest.ok) return;

		expect(latest.value.data.filename).toBe("statement.csv");
		expect(latest.value.meta.store_id).toBe("raw-documents");
	});

	it("sync-results store has parent refs to ai-parse-results", async () => {
		await ingestDocument(ctx, parser, filePath, config);

		const syncLatest = await ctx.corpus.stores["sync-results"].get_latest();
		expect(syncLatest.ok).toBe(true);
		if (!syncLatest.ok) return;

		const parents = syncLatest.value.meta.parents;
		expect(parents.length).toBeGreaterThan(0);

		for (const parent of parents) {
			expect(parent.store_id).toBe("ai-parse-results");
			expect(parent.version).toBeTruthy();
		}

		// Verify the parent version resolves
		const parentVersion = parents[0]?.version;
		if (parentVersion) {
			const parentSnapshot = await ctx.corpus.stores["ai-parse-results"].get(parentVersion);
			expect(parentSnapshot.ok).toBe(true);
			if (parentSnapshot.ok) {
				expect(parentSnapshot.value.data.transactions.length).toBe(2);
			}
		}
	});

	it("deterministic replay: re-running pipeline on corpus data produces same results", async () => {
		const { categorizeAll } = await import("../../src/pipeline/categorizer.js");
		const { loadMappings } = await import("../../src/pipeline/local-mappings.js");

		await ingestDocument(ctx, parser, filePath, config);

		// Extract parse results from corpus
		const parseSnapshot = await ctx.corpus.stores["ai-parse-results"].get_latest();
		expect(parseSnapshot.ok).toBe(true);
		if (!parseSnapshot.ok) return;

		const corpusTransactions = parseSnapshot.value.data.transactions;

		// Extract first-run sync results
		const firstSyncResult = await ctx.corpus.stores["sync-results"].get_latest();
		expect(firstSyncResult.ok).toBe(true);
		if (!firstSyncResult.ok) return;
		const firstData = firstSyncResult.value.data;

		// Re-run pipeline
		const mappingsResult = loadMappings();
		expect(mappingsResult.ok).toBe(true);
		if (!mappingsResult.ok) return;

		const { categorized, excluded } = await categorizeAll(corpusTransactions, {
			mappings: mappingsResult.value,
			rentConfig: config.rent,
		});

		expect(categorized.length).toBe(firstData.categorized.length);
		expect(excluded.length).toBe(firstData.excluded.length);

		for (const replayed of categorized) {
			const original = firstData.categorized.find((c: { externalId: string }) => c.externalId === replayed.externalId);
			expect(original).toBeTruthy();
			if (!original) continue;
			expect(replayed.category).toBe(original.category);
			expect(replayed.item).toBe(original.item);
		}
	});

	it("multiple ingests create multiple corpus snapshots with distinct versions", async () => {
		// First ingest
		await ingestDocument(ctx, parser, filePath, config);
		const snap1 = await ctx.corpus.stores["raw-documents"].get_latest();
		expect(snap1.ok).toBe(true);
		const version1 = snap1.ok ? snap1.value.meta.version : "";

		// Second ingest with different file
		const filePath2 = join(tmpDir, "statement2.csv");
		writeFileSync(filePath2, "different,data\n");
		await ingestDocument(ctx, parser, filePath2, config);
		const snap2 = await ctx.corpus.stores["raw-documents"].get_latest();
		expect(snap2.ok).toBe(true);
		const version2 = snap2.ok ? snap2.value.meta.version : "";

		expect(version1).not.toBe(version2);
		expect(version1).toBeTruthy();
		expect(version2).toBeTruthy();

		// Both should be listable
		const versions: string[] = [];
		for await (const meta of ctx.corpus.stores["raw-documents"].list()) {
			versions.push(meta.version);
		}
		expect(versions.length).toBeGreaterThanOrEqual(2);
		expect(versions).toContain(version1);
		expect(versions).toContain(version2);
	});
});

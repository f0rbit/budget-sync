import { beforeEach, describe, expect, it } from "bun:test";
import type { AppConfig } from "../../src/config.js";
import type { RawTransactionsSnapshot, SyncResultSnapshot } from "../../src/corpus/schemas.js";
import type { AppContext } from "../../src/db/client.js";
import { type PipelineContext, categorizeAll } from "../../src/pipeline/categorizer.js";
import { loadMappings } from "../../src/pipeline/local-mappings.js";
import type { RawTransaction } from "../../src/providers/types.js";
import { syncTransactions } from "../../src/services/sync-service.js";
import { createTestContext, createTestProvider, makeAccount, makeConfig, makeTransaction } from "../helpers.js";

function defaultSetup() {
	const acct = makeAccount({ id: "acc-1" });
	const txs: RawTransaction[] = [
		makeTransaction({
			id: "tx-1",
			description: "MCDONALDS BRISBANE",
			amount: 15,
			direction: "debit",
			transactionDate: "2026-03-05",
			postDate: "2026-03-05",
			accountId: "acc-1",
		}),
		makeTransaction({
			id: "tx-2",
			description: "WOOLWORTHS/5678 MELBOURNE",
			amount: 85,
			direction: "debit",
			transactionDate: "2026-03-06",
			postDate: "2026-03-06",
			accountId: "acc-1",
		}),
	];
	return { acct, txs };
}

describe("corpus lineage", () => {
	let ctx: AppContext;
	let config: AppConfig;

	beforeEach(() => {
		ctx = createTestContext();
		config = makeConfig();
	});

	it("raw-transactions store has snapshots after sync", async () => {
		const { acct, txs } = defaultSetup();
		const provider = createTestProvider({
			accounts: [acct],
			transactions: [{ accountId: "acc-1", items: txs }],
		});

		await syncTransactions(ctx, provider, config);

		const latest = await ctx.corpus.stores["raw-transactions"].get_latest();
		expect(latest.ok).toBe(true);
		if (!latest.ok) return;

		expect(latest.value.data.transactions.length).toBe(2);
		expect(latest.value.meta.store_id).toBe("raw-transactions");
		expect(latest.value.meta.tags).toContain("account:acc-1");
		expect(latest.value.meta.tags).toContain("provider:in-memory");
	});

	it("sync-results store has snapshots with parent refs linking to raw-transactions", async () => {
		const { acct, txs } = defaultSetup();
		const provider = createTestProvider({
			accounts: [acct],
			transactions: [{ accountId: "acc-1", items: txs }],
		});

		await syncTransactions(ctx, provider, config);

		const syncLatest = await ctx.corpus.stores["sync-results"].get_latest();
		expect(syncLatest.ok).toBe(true);
		if (!syncLatest.ok) return;

		const parents = syncLatest.value.meta.parents;
		expect(parents.length).toBeGreaterThan(0);

		// All parents should point to raw-transactions store
		for (const parent of parents) {
			expect(parent.store_id).toBe("raw-transactions");
			expect(parent.version).toBeTruthy();
		}

		// Verify the parent version actually resolves to a raw-transactions snapshot
		const parentVersion = parents[0]?.version;
		expect(parentVersion).toBeDefined();
		const parentSnapshot = await ctx.corpus.stores["raw-transactions"].get(parentVersion as string);
		expect(parentSnapshot.ok).toBe(true);
		if (parentSnapshot.ok) {
			expect(parentSnapshot.value.data.transactions.length).toBe(2);
		}
	});

	it("deterministic replay: re-running pipeline on extracted corpus data produces same results", async () => {
		const { acct, txs } = defaultSetup();
		const provider = createTestProvider({
			accounts: [acct],
			transactions: [{ accountId: "acc-1", items: txs }],
		});

		// Run the sync (first run)
		const syncResult = await syncTransactions(ctx, provider, config);
		expect(syncResult.ok).toBe(true);

		// Extract raw transactions from corpus
		const rawSnapshot = await ctx.corpus.stores["raw-transactions"].get_latest();
		expect(rawSnapshot.ok).toBe(true);
		if (!rawSnapshot.ok) return;

		const corpusTransactions: RawTransaction[] = rawSnapshot.value.data.transactions;

		// Extract first-run sync results from corpus
		const firstSyncResult = await ctx.corpus.stores["sync-results"].get_latest();
		expect(firstSyncResult.ok).toBe(true);
		if (!firstSyncResult.ok) return;
		const firstData: SyncResultSnapshot = firstSyncResult.value.data;

		// Re-run the pipeline independently on the extracted raw transactions
		const mappingsResult = loadMappings();
		expect(mappingsResult.ok).toBe(true);
		if (!mappingsResult.ok) return;

		const pipelineContext: PipelineContext = {
			mappings: mappingsResult.value,
			rentConfig: config.rent,
		};

		const { categorized, excluded } = await categorizeAll(corpusTransactions, pipelineContext);

		// Results should match exactly
		expect(categorized.length).toBe(firstData.categorized.length);
		expect(excluded.length).toBe(firstData.excluded.length);

		// Verify individual transaction matching
		for (const replayed of categorized) {
			const original = firstData.categorized.find((c) => c.externalId === replayed.externalId);
			expect(original).toBeTruthy();
			if (!original) continue;

			expect(replayed.category).toBe(original.category);
			expect(replayed.item).toBe(original.item);
			expect(replayed.amount).toBe(original.amount);
			expect(replayed.excluded).toBe(original.excluded);
		}
	});

	it("multiple syncs create multiple snapshots with distinct versions", async () => {
		const { acct } = defaultSetup();

		// First sync
		const provider1 = createTestProvider({
			accounts: [acct],
			transactions: [
				{
					accountId: "acc-1",
					items: [
						makeTransaction({
							id: "tx-round1",
							description: "MCDONALDS BRISBANE",
							amount: 10,
							accountId: "acc-1",
						}),
					],
				},
			],
		});
		await syncTransactions(ctx, provider1, config);

		const snap1 = await ctx.corpus.stores["raw-transactions"].get_latest();
		expect(snap1.ok).toBe(true);
		const version1 = snap1.ok ? snap1.value.meta.version : "";

		// Second sync with different data
		const provider2 = createTestProvider({
			accounts: [acct],
			transactions: [
				{
					accountId: "acc-1",
					items: [
						makeTransaction({
							id: "tx-round2",
							description: "SUBWAY MELBOURNE",
							amount: 8,
							accountId: "acc-1",
						}),
					],
				},
			],
		});
		await syncTransactions(ctx, provider2, config);

		const snap2 = await ctx.corpus.stores["raw-transactions"].get_latest();
		expect(snap2.ok).toBe(true);
		const version2 = snap2.ok ? snap2.value.meta.version : "";

		// Versions should differ
		expect(version1).not.toBe(version2);
		expect(version1).toBeTruthy();
		expect(version2).toBeTruthy();

		// Both should be listable
		const metas: string[] = [];
		for await (const meta of ctx.corpus.stores["raw-transactions"].list()) {
			metas.push(meta.version);
		}
		expect(metas.length).toBeGreaterThanOrEqual(2);
		expect(metas).toContain(version1);
		expect(metas).toContain(version2);
	});
});

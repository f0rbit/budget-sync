import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../../src/config.js";
import type { AppContext } from "../../src/db/client.js";
import { accounts, syncRuns, transactions } from "../../src/db/schema.js";
import type { InMemoryBankProvider } from "../../src/providers/in-memory/provider.js";
import type { AccountInfo, RawTransaction } from "../../src/providers/types.js";
import { type SyncOptions, syncTransactions } from "../../src/services/sync-service.js";
import { createTestContext, createTestProvider, makeAccount, makeConfig, makeTransaction } from "../helpers.js";

// --- Shared test fixtures ---

function defaultAccount(): AccountInfo {
	return makeAccount({ id: "acc-1", name: "Everyday Account", institution: "BankSA", type: "transaction" });
}

function defaultTransactions(): RawTransaction[] {
	return [
		makeTransaction({
			id: "tx-1",
			description: "WOOLWORTHS/1234 BRISBANE",
			amount: 42.5,
			direction: "debit",
			transactionDate: "2026-03-01",
			postDate: "2026-03-01",
			accountId: "acc-1",
		}),
		makeTransaction({
			id: "tx-2",
			description: "MCDONALDS SOUTH BRISBANE",
			amount: 15.0,
			direction: "debit",
			transactionDate: "2026-03-02",
			postDate: "2026-03-02",
			accountId: "acc-1",
		}),
	];
}

function setupProvider(opts?: { failAuth?: boolean }): InMemoryBankProvider {
	const acct = defaultAccount();
	const txs = defaultTransactions();
	const provider = createTestProvider({
		accounts: [acct],
		transactions: [{ accountId: "acc-1", items: txs }],
		balances: [{ accountId: "acc-1", balance: 1500, available: 1400, asOf: "2026-03-01" }],
	});
	if (opts?.failAuth) provider.failNextAuth = true;
	return provider;
}

describe("sync-workflow", () => {
	let ctx: AppContext;
	let config: AppConfig;

	beforeEach(() => {
		ctx = createTestContext();
		config = makeConfig();
	});

	it("creates accounts and transactions in DB after full sync", async () => {
		const provider = setupProvider();
		const result = await syncTransactions(ctx, provider, config);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const dbAccounts = ctx.db.select().from(accounts).all();
		expect(dbAccounts.length).toBe(1);
		expect(dbAccounts[0]?.externalId).toBe("acc-1");
		expect(dbAccounts[0]?.name).toBe("Everyday Account");

		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(result.value.transactionsCreated);
		expect(result.value.transactionsCreated).toBeGreaterThan(0);
	});

	it("creates corpus snapshots for raw-transactions, raw-accounts, and sync-results", async () => {
		const provider = setupProvider();
		const result = await syncTransactions(ctx, provider, config);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Check raw-accounts store
		const accountsLatest = await ctx.corpus.stores["raw-accounts"].get_latest();
		expect(accountsLatest.ok).toBe(true);
		if (accountsLatest.ok) {
			expect(accountsLatest.value.data.provider).toBe("in-memory");
			expect(accountsLatest.value.data.accounts.length).toBe(1);
		}

		// Check raw-transactions store
		const txLatest = await ctx.corpus.stores["raw-transactions"].get_latest();
		expect(txLatest.ok).toBe(true);
		if (txLatest.ok) {
			expect(txLatest.value.data.transactions.length).toBe(2);
			expect(txLatest.value.data.accountId).toBe("acc-1");
		}

		// Check sync-results store
		const syncLatest = await ctx.corpus.stores["sync-results"].get_latest();
		expect(syncLatest.ok).toBe(true);
		if (syncLatest.ok) {
			expect(syncLatest.value.data.syncRunId).toBeTruthy();
			expect(syncLatest.value.data.stats.totalFetched).toBe(2);
		}
	});

	it("prevents duplicate transactions by external_id", async () => {
		const provider = setupProvider();

		// First sync
		const result1 = await syncTransactions(ctx, provider, config);
		expect(result1.ok).toBe(true);
		if (!result1.ok) return;
		const firstCount = result1.value.transactionsCreated;

		// Second sync with same transactions
		const provider2 = setupProvider();
		const result2 = await syncTransactions(ctx, provider2, config);
		expect(result2.ok).toBe(true);
		if (!result2.ok) return;

		// Second sync should create 0 new transactions and skip duplicates
		expect(result2.value.transactionsCreated).toBe(0);
		expect(result2.value.transactionsSkipped).toBe(firstCount);

		// DB should have same count as after first sync
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(firstCount);
	});

	it("dry-run creates corpus snapshots but no DB transactions", async () => {
		const provider = setupProvider();
		const options: SyncOptions = { dryRun: true };
		const result = await syncTransactions(ctx, provider, config, options);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// No transactions in DB
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(0);
		expect(result.value.transactionsCreated).toBe(0);

		// But corpus snapshots should still exist
		const syncLatest = await ctx.corpus.stores["sync-results"].get_latest();
		expect(syncLatest.ok).toBe(true);

		const txLatest = await ctx.corpus.stores["raw-transactions"].get_latest();
		expect(txLatest.ok).toBe(true);
	});

	it("sync run record has correct counts", async () => {
		const provider = createTestProvider({
			accounts: [defaultAccount()],
			transactions: [
				{
					accountId: "acc-1",
					items: [
						...defaultTransactions(),
						// Add a credit transaction (will be excluded by filter)
						makeTransaction({
							id: "tx-credit",
							description: "SALARY DEPOSIT",
							amount: 3000,
							direction: "credit",
							transactionDate: "2026-03-01",
							postDate: "2026-03-01",
							accountId: "acc-1",
						}),
						// Add an exclusion-matching transaction
						makeTransaction({
							id: "tx-excluded",
							description: "To 460184 Credit Card Payment",
							amount: 500,
							direction: "debit",
							transactionDate: "2026-03-01",
							postDate: "2026-03-01",
							accountId: "acc-1",
						}),
					],
				},
			],
		});

		const result = await syncTransactions(ctx, provider, config);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const syncRunRows = ctx.db.select().from(syncRuns).all();
		expect(syncRunRows.length).toBe(1);

		const run = syncRunRows[0];
		expect(run).toBeDefined();
		expect(run?.status).toBe("success");
		expect(run?.transactionsCreated).toBe(result.value.transactionsCreated);
		expect(run?.transactionsExcluded).toBe(result.value.transactionsExcluded);
		// The credit + exclusion-matched transactions should be excluded
		expect(result.value.transactionsExcluded).toBeGreaterThanOrEqual(2);
	});

	it("provider auth failure returns Result.err without crash", async () => {
		const provider = setupProvider({ failAuth: true });
		const result = await syncTransactions(ctx, provider, config);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("AUTH_FAILED");

		// Sync run should be marked as failed
		const syncRunRows = ctx.db.select().from(syncRuns).all();
		expect(syncRunRows.length).toBe(1);
		expect(syncRunRows[0]?.status).toBe("failed");
	});

	it("date range filtering returns only matching transactions", async () => {
		const acct = defaultAccount();
		const provider = createTestProvider({
			accounts: [acct],
			transactions: [
				{
					accountId: "acc-1",
					items: [
						makeTransaction({
							id: "tx-jan",
							description: "WOOLWORTHS/9999 SYDNEY",
							amount: 20,
							direction: "debit",
							transactionDate: "2026-01-15",
							postDate: "2026-01-15",
							accountId: "acc-1",
						}),
						makeTransaction({
							id: "tx-mar",
							description: "MCDONALDS BRISBANE",
							amount: 12,
							direction: "debit",
							transactionDate: "2026-03-10",
							postDate: "2026-03-10",
							accountId: "acc-1",
						}),
					],
				},
			],
		});

		const options: SyncOptions = {
			dateFrom: "2026-03-01",
			dateTo: "2026-03-31",
		};

		const result = await syncTransactions(ctx, provider, config, options);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Only the March transaction should be synced
		const dbTxs = ctx.db.select().from(transactions).all();
		expect(dbTxs.length).toBe(1);
		expect(dbTxs[0]?.date).toBe("2026-03-10");
	});
});

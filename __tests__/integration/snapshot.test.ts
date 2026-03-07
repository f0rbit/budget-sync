import { beforeEach, describe, expect, it } from "bun:test";
import type { AppConfig } from "../../src/config.js";
import type { AppContext } from "../../src/db/client.js";
import { snapshots } from "../../src/db/schema.js";
import { upsertAccount } from "../../src/services/account-service.js";
import { getLatestSnapshots, getSnapshotHistory, upsertSnapshot } from "../../src/services/snapshot-service.js";
import { syncTransactions } from "../../src/services/sync-service.js";
import { createTestContext, createTestProvider, makeAccount, makeBalance, makeConfig } from "../helpers.js";

describe("snapshot-service", () => {
	let ctx: AppContext;
	let config: AppConfig;

	beforeEach(() => {
		ctx = createTestContext();
		config = makeConfig();
	});

	it("upsertSnapshot creates new snapshot", async () => {
		const acctResult = await upsertAccount(ctx.db, "test", makeAccount({ id: "ext-1", type: "savings" }));
		expect(acctResult.ok).toBe(true);
		if (!acctResult.ok) return;

		const result = await upsertSnapshot(ctx.db, {
			accountId: acctResult.value.id,
			date: "2026-03-01",
			balance: 1500,
			available: 1400,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.balance).toBe(1500);
		expect(result.value.date).toBe("2026-03-01");
		expect(result.value.accountId).toBe(acctResult.value.id);
	});

	it("upsertSnapshot updates on same (account, date)", async () => {
		const acctResult = await upsertAccount(ctx.db, "test", makeAccount({ id: "ext-1", type: "savings" }));
		expect(acctResult.ok).toBe(true);
		if (!acctResult.ok) return;

		const accountId = acctResult.value.id;

		await upsertSnapshot(ctx.db, { accountId, date: "2026-03-01", balance: 1500 });
		const result = await upsertSnapshot(ctx.db, { accountId, date: "2026-03-01", balance: 1600 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.balance).toBe(1600);

		const rows = ctx.db.select().from(snapshots).all();
		expect(rows.length).toBe(1);
	});

	it("getLatestSnapshots returns one per account", async () => {
		const acctA = await upsertAccount(ctx.db, "test", makeAccount({ id: "ext-a", name: "Account A" }));
		const acctB = await upsertAccount(ctx.db, "test", makeAccount({ id: "ext-b", name: "Account B" }));
		expect(acctA.ok).toBe(true);
		expect(acctB.ok).toBe(true);
		if (!acctA.ok || !acctB.ok) return;

		for (const date of ["2026-03-01", "2026-03-02", "2026-03-03"]) {
			await upsertSnapshot(ctx.db, { accountId: acctA.value.id, date, balance: 1000 });
		}
		for (const date of ["2026-03-01", "2026-03-02"]) {
			await upsertSnapshot(ctx.db, { accountId: acctB.value.id, date, balance: 2000 });
		}

		const result = await getLatestSnapshots(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.length).toBe(2);

		const snapA = result.value.find((s) => s.accountId === acctA.value.id);
		const snapB = result.value.find((s) => s.accountId === acctB.value.id);
		expect(snapA?.date).toBe("2026-03-03");
		expect(snapB?.date).toBe("2026-03-02");
	});

	it("getLatestSnapshots joins account name/type", async () => {
		const acctResult = await upsertAccount(
			ctx.db,
			"test",
			makeAccount({ id: "ext-1", name: "Savings", type: "savings" }),
		);
		expect(acctResult.ok).toBe(true);
		if (!acctResult.ok) return;

		await upsertSnapshot(ctx.db, { accountId: acctResult.value.id, date: "2026-03-01", balance: 5000 });

		const result = await getLatestSnapshots(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value[0]?.accountName).toBe("Savings");
		expect(result.value[0]?.accountType).toBe("savings");
	});

	it("getSnapshotHistory with date range filter", async () => {
		const acctResult = await upsertAccount(ctx.db, "test", makeAccount({ id: "ext-1" }));
		expect(acctResult.ok).toBe(true);
		if (!acctResult.ok) return;

		const accountId = acctResult.value.id;
		await upsertSnapshot(ctx.db, { accountId, date: "2026-03-01", balance: 1000 });
		await upsertSnapshot(ctx.db, { accountId, date: "2026-03-05", balance: 1100 });
		await upsertSnapshot(ctx.db, { accountId, date: "2026-03-10", balance: 1200 });

		const result = await getSnapshotHistory(ctx.db, { dateFrom: "2026-03-03", dateTo: "2026-03-07" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.length).toBe(1);
		expect(result.value[0]?.date).toBe("2026-03-05");
	});

	it("sync materializes balances to snapshots table", async () => {
		const provider = createTestProvider({
			accounts: [makeAccount({ id: "acc-1", name: "Everyday", type: "transaction" })],
			transactions: [],
			balances: [makeBalance({ accountId: "acc-1", balance: 1500, available: 1400 })],
		});

		const result = await syncTransactions(ctx, provider, config);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = ctx.db.select().from(snapshots).all();
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(rows[0]?.balance).toBe(1500);
	});

	it("sync with auto_snapshot: false skips materialization", async () => {
		const provider = createTestProvider({
			accounts: [makeAccount({ id: "acc-1", name: "Everyday", type: "transaction" })],
			transactions: [],
			balances: [makeBalance({ accountId: "acc-1", balance: 1500 })],
		});

		config.sync.auto_snapshot = false;
		const result = await syncTransactions(ctx, provider, config);
		expect(result.ok).toBe(true);

		const rows = ctx.db.select().from(snapshots).all();
		expect(rows.length).toBe(0);
	});

	it("sync with balance fetch failure doesn't fail sync", async () => {
		const provider = createTestProvider({
			accounts: [makeAccount({ id: "acc-1", name: "Everyday", type: "transaction" })],
			transactions: [],
			balances: [makeBalance({ accountId: "acc-1", balance: 1500 })],
		});
		provider.failNextBalances = true;

		const result = await syncTransactions(ctx, provider, config);
		expect(result.ok).toBe(true);

		const rows = ctx.db.select().from(snapshots).all();
		expect(rows.length).toBe(0);
	});

	it("multiple syncs on same day update existing snapshots", async () => {
		const provider1 = createTestProvider({
			accounts: [makeAccount({ id: "acc-1", name: "Everyday", type: "transaction" })],
			transactions: [],
			balances: [makeBalance({ accountId: "acc-1", balance: 1500, available: 1400 })],
		});

		const result1 = await syncTransactions(ctx, provider1, config);
		expect(result1.ok).toBe(true);

		const rowsAfterFirst = ctx.db.select().from(snapshots).all();
		expect(rowsAfterFirst.length).toBe(1);
		expect(rowsAfterFirst[0]?.balance).toBe(1500);

		const provider2 = createTestProvider({
			accounts: [makeAccount({ id: "acc-1", name: "Everyday", type: "transaction" })],
			transactions: [],
			balances: [makeBalance({ accountId: "acc-1", balance: 1600, available: 1500 })],
		});

		const result2 = await syncTransactions(ctx, provider2, config);
		expect(result2.ok).toBe(true);

		const rowsAfterSecond = ctx.db.select().from(snapshots).all();
		expect(rowsAfterSecond.length).toBe(1);
		expect(rowsAfterSecond[0]?.balance).toBe(1600);
	});

	it("snapshot flow — service layer only (manual balance capture without sync)", async () => {
		const acctResult = await upsertAccount(
			ctx.db,
			"test",
			makeAccount({ id: "ext-1", name: "Manual Account", type: "savings" }),
		);
		expect(acctResult.ok).toBe(true);
		if (!acctResult.ok) return;

		const accountId = acctResult.value.id;
		const insertResult = await upsertSnapshot(ctx.db, { accountId, date: "2026-03-01", balance: 9500 });
		expect(insertResult.ok).toBe(true);

		const latest = await getLatestSnapshots(ctx.db);
		expect(latest.ok).toBe(true);
		if (!latest.ok) return;

		expect(latest.value.length).toBe(1);
		expect(latest.value[0]?.balance).toBe(9500);
		expect(latest.value[0]?.accountName).toBe("Manual Account");
	});
});

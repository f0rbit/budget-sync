import { beforeEach, describe, expect, it } from "bun:test";
import type { AppConfig } from "../../src/config.js";
import type { AppContext } from "../../src/db/client.js";
import type { AccountInfo } from "../../src/providers/types.js";
import { upsertAccount } from "../../src/services/account-service.js";
import { getCurrentNetWorth, getNetWorthHistory } from "../../src/services/networth-service.js";
import { upsertSnapshot } from "../../src/services/snapshot-service.js";
import { syncTransactions } from "../../src/services/sync-service.js";
import { createTestContext, createTestProvider, makeAccount, makeConfig } from "../helpers.js";

describe("networth-service", () => {
	let ctx: AppContext;
	let config: AppConfig;

	beforeEach(() => {
		ctx = createTestContext();
		config = makeConfig();
	});

	async function seedAccount(overrides: Partial<AccountInfo>): Promise<string> {
		const info = makeAccount(overrides);
		const result = await upsertAccount(ctx.db, "test", info);
		if (!result.ok) throw new Error("Failed to seed account");
		return result.value.id;
	}

	it("N1: net worth with savings + transaction accounts", async () => {
		const savingsId = await seedAccount({ id: "ext-sav", type: "savings", name: "Savings" });
		const txId = await seedAccount({ id: "ext-tx", type: "transaction", name: "Everyday" });

		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-01", balance: 10000 });
		await upsertSnapshot(ctx.db, { accountId: txId, date: "2026-03-01", balance: 3000 });

		const result = await getCurrentNetWorth(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.netWorth).toBe(13000);
		expect(result.value.components.savings).toBe(10000);
		expect(result.value.components.transaction).toBe(3000);
		expect(result.value.components.credit).toBe(0);
	});

	it("N2: net worth with credit card debt", async () => {
		const savingsId = await seedAccount({ id: "ext-sav", type: "savings", name: "Savings" });
		const txId = await seedAccount({ id: "ext-tx", type: "transaction", name: "Everyday" });
		const creditId = await seedAccount({ id: "ext-cc", type: "credit", name: "Credit Card" });

		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-01", balance: 10000 });
		await upsertSnapshot(ctx.db, { accountId: txId, date: "2026-03-01", balance: 3000 });
		await upsertSnapshot(ctx.db, { accountId: creditId, date: "2026-03-01", balance: 1250 });

		const result = await getCurrentNetWorth(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.netWorth).toBe(11750);
		expect(result.value.components.credit).toBe(1250);
	});

	it("N3: net worth with no snapshots", async () => {
		const result = await getCurrentNetWorth(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.netWorth).toBe(0);
		expect(result.value.accounts).toHaveLength(0);
	});

	it("N4: net worth ignores super/investment accounts", async () => {
		const savingsId = await seedAccount({ id: "ext-sav", type: "savings", name: "Savings" });
		const superId = await seedAccount({ id: "ext-super", type: "super", name: "Super Fund" });
		const investId = await seedAccount({ id: "ext-inv", type: "investment", name: "Shares" });

		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-01", balance: 10000 });
		await upsertSnapshot(ctx.db, { accountId: superId, date: "2026-03-01", balance: 50000 });
		await upsertSnapshot(ctx.db, { accountId: investId, date: "2026-03-01", balance: 20000 });

		const result = await getCurrentNetWorth(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.netWorth).toBe(10000);
		expect(result.value.accounts).toHaveLength(1);
	});

	it("N5: net worth history returns entries per date", async () => {
		const savingsId = await seedAccount({ id: "ext-sav", type: "savings", name: "Savings" });

		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-01", balance: 1000 });
		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-02", balance: 1100 });
		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-03", balance: 1200 });

		const result = await getNetWorthHistory(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toHaveLength(3);
		expect(result.value[0]?.date).toBe("2026-03-01");
		expect(result.value[0]?.netWorth).toBe(1000);
		expect(result.value[1]?.netWorth).toBe(1100);
		expect(result.value[2]?.netWorth).toBe(1200);
	});

	it("N6: net worth history carry-forward", async () => {
		const aId = await seedAccount({ id: "ext-a", type: "savings", name: "Savings A" });
		const bId = await seedAccount({ id: "ext-b", type: "transaction", name: "Transaction B" });

		await upsertSnapshot(ctx.db, { accountId: aId, date: "2026-03-01", balance: 1000 });
		await upsertSnapshot(ctx.db, { accountId: bId, date: "2026-03-01", balance: 500 });
		await upsertSnapshot(ctx.db, { accountId: aId, date: "2026-03-02", balance: 1100 });

		const result = await getNetWorthHistory(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toHaveLength(2);
		expect(result.value[0]?.netWorth).toBe(1500);
		expect(result.value[1]?.netWorth).toBe(1600);
	});

	it("N7: net worth history with date range filter", async () => {
		const savingsId = await seedAccount({ id: "ext-sav", type: "savings", name: "Savings" });

		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-01", balance: 1000 });
		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-05", balance: 1500 });
		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-10", balance: 2000 });

		const result = await getNetWorthHistory(ctx.db, { dateFrom: "2026-03-03", dateTo: "2026-03-07" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toHaveLength(1);
		expect(result.value[0]?.date).toBe("2026-03-05");
		expect(result.value[0]?.netWorth).toBe(1500);
	});

	it("N8: full sync → net worth reflects balances", async () => {
		const provider = createTestProvider({
			accounts: [makeAccount({ id: "acc-sav", type: "savings", name: "Savings" })],
			balances: [{ accountId: "acc-sav", balance: 5000, available: 5000, asOf: "2026-03-01" }],
			transactions: [],
		});

		const result = await syncTransactions(ctx, provider, config);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const nw = await getCurrentNetWorth(ctx.db);
		expect(nw.ok).toBe(true);
		if (!nw.ok) return;

		expect(nw.value.netWorth).toBe(5000);
		expect(nw.value.components.savings).toBe(5000);
	});
});

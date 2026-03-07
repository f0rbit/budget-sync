import { beforeEach, describe, expect, it } from "bun:test";
import type { AppContext } from "../../src/db/client.js";
import type { AccountInfo } from "../../src/providers/types.js";
import { upsertAccount } from "../../src/services/account-service.js";
import { getCurrentNetWorth, getNetWorthHistory } from "../../src/services/networth-service.js";
import { upsertSnapshot } from "../../src/services/snapshot-service.js";
import { syncSuper } from "../../src/services/super-sync-service.js";
import { createTestContext, createTestSuperProvider, makeAccount, makeSuperBalance } from "../helpers.js";

describe("super-networth", () => {
	let ctx: AppContext;

	beforeEach(() => {
		ctx = createTestContext();
	});

	async function seedAccount(overrides: Partial<AccountInfo>): Promise<string> {
		const info = makeAccount(overrides);
		const result = await upsertAccount(ctx.db, "test", info);
		if (!result.ok) throw new Error("Failed to seed account");
		return result.value.id;
	}

	it("SN1: net worth includes super balance", async () => {
		const savingsId = await seedAccount({ id: "ext-sav", type: "savings", name: "Savings" });
		const superId = await seedAccount({ id: "ext-super", type: "super", name: "Super Fund" });

		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-01", balance: 10000 });
		await upsertSnapshot(ctx.db, { accountId: superId, date: "2026-03-01", balance: 50000 });

		const result = await getCurrentNetWorth(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.netWorth).toBe(60000);
		expect(result.value.components.super).toBe(50000);
		expect(result.value.components.savings).toBe(10000);
	});

	it("SN2: net worth with all account types", async () => {
		const savingsId = await seedAccount({ id: "ext-sav", type: "savings", name: "Savings" });
		const txId = await seedAccount({ id: "ext-tx", type: "transaction", name: "Everyday" });
		const superId = await seedAccount({ id: "ext-super", type: "super", name: "Super Fund" });
		const creditId = await seedAccount({ id: "ext-cc", type: "credit", name: "Credit Card" });

		await upsertSnapshot(ctx.db, { accountId: savingsId, date: "2026-03-01", balance: 10000 });
		await upsertSnapshot(ctx.db, { accountId: txId, date: "2026-03-01", balance: 3000 });
		await upsertSnapshot(ctx.db, { accountId: superId, date: "2026-03-01", balance: 50000 });
		await upsertSnapshot(ctx.db, { accountId: creditId, date: "2026-03-01", balance: 1250 });

		const result = await getCurrentNetWorth(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.netWorth).toBe(61750);
		expect(result.value.components.savings).toBe(10000);
		expect(result.value.components.transaction).toBe(3000);
		expect(result.value.components.super).toBe(50000);
		expect(result.value.components.credit).toBe(1250);
	});

	it("SN3: net worth history includes super component", async () => {
		const superId = await seedAccount({ id: "ext-super", type: "super", name: "Super Fund" });

		await upsertSnapshot(ctx.db, { accountId: superId, date: "2026-03-01", balance: 80000 });
		await upsertSnapshot(ctx.db, { accountId: superId, date: "2026-03-02", balance: 80500 });

		const result = await getNetWorthHistory(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toHaveLength(2);
		expect(result.value[0]?.super).toBe(80000);
		expect(result.value[0]?.netWorth).toBe(80000);
		expect(result.value[1]?.super).toBe(80500);
		expect(result.value[1]?.netWorth).toBe(80500);
	});

	it("SN4: net worth history carry-forward with super", async () => {
		const aId = await seedAccount({ id: "ext-a", type: "savings", name: "Savings A" });
		const bId = await seedAccount({ id: "ext-b", type: "super", name: "Super Fund" });

		await upsertSnapshot(ctx.db, { accountId: aId, date: "2026-03-01", balance: 5000 });
		await upsertSnapshot(ctx.db, { accountId: bId, date: "2026-03-01", balance: 80000 });
		await upsertSnapshot(ctx.db, { accountId: aId, date: "2026-03-02", balance: 5500 });

		const result = await getNetWorthHistory(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toHaveLength(2);
		expect(result.value[0]?.netWorth).toBe(85000);
		expect(result.value[1]?.netWorth).toBe(85500);
	});

	it("SN5: super import → net worth reflects balance", async () => {
		const provider = createTestSuperProvider({
			balance: makeSuperBalance({ balance: 90000, asOf: "2026-03-01" }),
		});

		const syncResult = await syncSuper(ctx, provider);
		expect(syncResult.ok).toBe(true);

		const result = await getCurrentNetWorth(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.netWorth).toBe(90000);
		expect(result.value.components.super).toBe(90000);
	});
});

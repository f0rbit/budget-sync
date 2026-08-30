import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../../src/db/client.js";
import type { CategorizedTransaction } from "../../src/providers/types.js";
import { upsertAccount } from "../../src/services/account-service.js";
import { createTransaction, selectTransactions, updateTransactions } from "../../src/services/transaction-service.js";
import { createTestContext } from "../helpers.js";

function makeCatTx(overrides: Partial<CategorizedTransaction> & { externalId: string }): CategorizedTransaction {
	return {
		date: "2026-03-05",
		postDate: "2026-03-05",
		rawDescription: "TEST TRANSACTION",
		item: "Test Item",
		amount: 25.0,
		direction: "debit",
		category: "Other",
		notes: "",
		excluded: false,
		accountId: "acc-1",
		...overrides,
	};
}

describe("transactions set (selectTransactions / updateTransactions)", () => {
	let db: AppDatabase;
	let accountId: string;

	beforeEach(async () => {
		const ctx = createTestContext();
		db = ctx.db;
		const result = await upsertAccount(db, "test", {
			id: "acc-1",
			name: "Test Account",
			institution: "TestBank",
			type: "transaction",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		accountId = result.value.id;
	});

	it("updates rows selected by id", async () => {
		const created = await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-1", rawDescription: "Post West End Post Sho", amount: 552.5 }),
		);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const selected = await selectTransactions(db, { ids: [created.value.id] });
		expect(selected.ok).toBe(true);
		if (!selected.ok) return;
		expect(selected.value).toHaveLength(1);

		const updated = await updateTransactions(db, [created.value.id], {
			category: "Travel",
			item: "Passport",
		});
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.value[0]?.category).toBe("Travel");
		expect(updated.value[0]?.item).toBe("Passport");
	});

	it("selects rows by --match/--from/--to filter", async () => {
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-1", rawDescription: "Eftpos Beem Debit", date: "2026-07-31", amount: 354.34 }),
		);
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-2", rawDescription: "Eftpos Beem Debit", date: "2026-08-24", amount: 750.0 }),
		);
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-3", rawDescription: "Eftpos Beem Debit", date: "2026-05-01", amount: 10.0 }),
		);
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-4", rawDescription: "Woolworths Metro", date: "2026-07-31", amount: 20.0 }),
		);

		const selected = await selectTransactions(db, { match: "Beem", dateFrom: "2026-07-01" });
		expect(selected.ok).toBe(true);
		if (!selected.ok) return;
		expect(selected.value.map((r) => r.externalId).sort()).toEqual(["tx-1", "tx-2"]);

		const updated = await updateTransactions(
			db,
			selected.value.map((r) => r.id),
			{ category: "Travel", item: "Japan trip (Feb 2027)" },
		);
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.value.every((r) => r.category === "Travel" && r.item === "Japan trip (Feb 2027)")).toBe(true);
	});

	it("only updates provided fields, leaving others untouched", async () => {
		const created = await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-1", item: "Original Item", category: "Shopping", notes: "orig notes" }),
		);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const updated = await updateTransactions(db, [created.value.id], { notes: "new notes" });
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.value[0]?.notes).toBe("new notes");
		expect(updated.value[0]?.item).toBe("Original Item");
		expect(updated.value[0]?.category).toBe("Shopping");
	});
});

import { beforeEach, describe, expect, it } from "bun:test";
import { type AppDatabase, createTestDb } from "../../src/db/client.js";
import type { CategorizedTransaction } from "../../src/providers/types.js";
import { upsertAccount } from "../../src/services/account-service.js";
import { createTransaction, getTransactions, getUncategorized } from "../../src/services/transaction-service.js";

function makeCategorizedTx(
	overrides: Partial<CategorizedTransaction> & { externalId: string },
): CategorizedTransaction {
	return {
		externalId: overrides.externalId,
		date: overrides.date ?? "2026-03-01",
		postDate: overrides.postDate ?? "2026-03-01",
		rawDescription: overrides.rawDescription ?? "TEST TRANSACTION",
		item: overrides.item ?? "Test Item",
		amount: overrides.amount ?? 10.0,
		direction: overrides.direction ?? "debit",
		category: overrides.category ?? "Other",
		notes: overrides.notes ?? "",
		excluded: overrides.excluded ?? false,
		accountId: overrides.accountId ?? "ext-1",
	};
}

describe("transaction-service", () => {
	let db: AppDatabase;
	let accountId: string;

	beforeEach(async () => {
		db = createTestDb();
		const result = await upsertAccount(db, "test", {
			id: "ext-1",
			name: "Test",
			institution: "Test",
			type: "transaction",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		accountId = result.value.id;
	});

	describe("getTransactions", () => {
		it("returns all transactions when no filters", async () => {
			for (const id of ["tx-1", "tx-2", "tx-3"]) {
				await createTransaction(db, accountId, makeCategorizedTx({ externalId: id }));
			}

			const result = await getTransactions(db);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(3);
		});

		it("filters by dateFrom", async () => {
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-1", date: "2026-03-01" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-2", date: "2026-03-05" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-3", date: "2026-03-10" }));

			const result = await getTransactions(db, { dateFrom: "2026-03-05" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(2);
		});

		it("filters by dateTo", async () => {
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-1", date: "2026-03-01" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-2", date: "2026-03-05" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-3", date: "2026-03-10" }));

			const result = await getTransactions(db, { dateTo: "2026-03-05" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(2);
		});

		it("filters by date range (dateFrom + dateTo)", async () => {
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-1", date: "2026-03-01" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-2", date: "2026-03-05" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-3", date: "2026-03-10" }));

			const result = await getTransactions(db, { dateFrom: "2026-03-02", dateTo: "2026-03-09" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(1);
			expect(result.value[0]?.date).toBe("2026-03-05");
		});

		it("filters by category", async () => {
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-1", category: "Rent" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-2", category: "Other" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-3", category: "Other" }));

			const result = await getTransactions(db, { category: "Other" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(2);
			expect(result.value.every((tx) => tx.category === "Other")).toBe(true);
		});

		it("filters by accountId", async () => {
			const account2 = await upsertAccount(db, "test", {
				id: "ext-2",
				name: "Savings",
				institution: "Test",
				type: "savings",
			});
			expect(account2.ok).toBe(true);
			if (!account2.ok) return;

			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-1" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-2" }));
			await createTransaction(db, account2.value.id, makeCategorizedTx({ externalId: "tx-3", accountId: "ext-2" }));

			const result = await getTransactions(db, { accountId });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(2);
			expect(result.value.every((tx) => tx.accountId === accountId)).toBe(true);
		});

		it("filters by limit", async () => {
			for (let i = 1; i <= 5; i++) {
				await createTransaction(db, accountId, makeCategorizedTx({ externalId: `tx-${i}` }));
			}

			const result = await getTransactions(db, { limit: 2 });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(2);
		});

		it("combines multiple filters", async () => {
			await createTransaction(
				db,
				accountId,
				makeCategorizedTx({ externalId: "tx-1", date: "2026-03-01", category: "Rent" }),
			);
			await createTransaction(
				db,
				accountId,
				makeCategorizedTx({ externalId: "tx-2", date: "2026-03-05", category: "Other" }),
			);
			await createTransaction(
				db,
				accountId,
				makeCategorizedTx({ externalId: "tx-3", date: "2026-03-10", category: "Other" }),
			);
			await createTransaction(
				db,
				accountId,
				makeCategorizedTx({ externalId: "tx-4", date: "2026-03-15", category: "Other" }),
			);

			const result = await getTransactions(db, {
				dateFrom: "2026-03-04",
				category: "Other",
				limit: 1,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(1);
			expect(result.value[0]?.category).toBe("Other");
		});
	});

	describe("getUncategorized", () => {
		it("returns only transactions with category Other", async () => {
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-1", category: "Rent" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-2", category: "Rent" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-3", category: "Other" }));

			const result = await getUncategorized(db);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(1);
			expect(result.value[0]?.category).toBe("Other");
		});

		it("returns empty array when no uncategorized", async () => {
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-1", category: "Rent" }));
			await createTransaction(db, accountId, makeCategorizedTx({ externalId: "tx-2", category: "Rent" }));

			const result = await getUncategorized(db);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(0);
		});
	});
});

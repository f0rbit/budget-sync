import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../../src/db/client.js";
import type { CategorizedTransaction } from "../../src/providers/types.js";
import { summarizeTransactions } from "../../src/reporting/summary.js";
import { upsertAccount } from "../../src/services/account-service.js";
import {
	createTransaction,
	getReportRows,
	getTransactions,
	searchTransactions,
} from "../../src/services/transaction-service.js";
import { createTestContext } from "../helpers.js";

function makeCatTx(overrides: Partial<CategorizedTransaction> & { externalId: string }): CategorizedTransaction {
	return {
		date: "2026-03-05",
		postDate: "2026-03-05",
		rawDescription: "TEST TRANSACTION",
		item: "Test Item",
		amount: 25.0,
		direction: "debit",
		category: "Shopping",
		notes: "",
		excluded: false,
		accountId: "acc-1",
		...overrides,
	};
}

describe("transactions CLI service", () => {
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

	describe("getTransactions", () => {
		it("filters by date range", async () => {
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-1", date: "2026-03-01" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-2", date: "2026-03-05" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-3", date: "2026-03-10" }));

			const result = await getTransactions(db, { dateFrom: "2026-03-04", dateTo: "2026-03-06" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(1);
			expect(result.value[0]?.date).toBe("2026-03-05");
		});

		it("filters by category", async () => {
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-1", category: "Eating Out" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-2", category: "Eating Out" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-3", category: "Shopping" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-4", category: "Other" }));

			const result = await getTransactions(db, { category: "Eating Out" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(2);
			expect(result.value.every((tx) => tx.category === "Eating Out")).toBe(true);
		});

		it("respects limit and orders by date descending", async () => {
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-1", date: "2026-03-01" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-2", date: "2026-03-03" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-3", date: "2026-03-05" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-4", date: "2026-03-07" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-5", date: "2026-03-09" }));

			const result = await getTransactions(db, { limit: 3 });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(3);
			expect(result.value[0]?.date).toBe("2026-03-09");
			expect(result.value[1]?.date).toBe("2026-03-07");
			expect(result.value[2]?.date).toBe("2026-03-05");
		});

		it("filters by accountId", async () => {
			const acct2Result = await upsertAccount(db, "test", {
				id: "acc-2",
				name: "Savings Account",
				institution: "TestBank",
				type: "savings",
			});
			expect(acct2Result.ok).toBe(true);
			if (!acct2Result.ok) return;
			const account2Id = acct2Result.value.id;

			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-1" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-2" }));
			await createTransaction(db, account2Id, makeCatTx({ externalId: "tx-3", accountId: "acc-2" }));

			const result = await getTransactions(db, { accountId });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(2);
			expect(result.value.every((tx) => tx.accountId === accountId)).toBe(true);
		});

		it("combines date, category, and limit filters", async () => {
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-1", date: "2026-03-01", category: "Eating Out" }),
			);
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-2", date: "2026-03-05", category: "Eating Out" }),
			);
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-3", date: "2026-03-10", category: "Eating Out" }),
			);
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-4", date: "2026-03-15", category: "Shopping" }),
			);

			const result = await getTransactions(db, {
				dateFrom: "2026-03-01",
				category: "Eating Out",
				limit: 5,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(3);
			expect(result.value.every((tx) => tx.category === "Eating Out")).toBe(true);
		});

		it("returns empty array on empty database", async () => {
			const result = await getTransactions(db);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value).toEqual([]);
		});
	});

	describe("searchTransactions", () => {
		it("matches by item case-insensitively", async () => {
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-1", item: "McDonald's", rawDescription: "MCDONALDS SOUTH BRISBANE QLD" }),
			);
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-2", item: "Woolworths", rawDescription: "WOOLWORTHS 1234 ADELAIDE" }),
			);
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-3", item: "Uber Eats", rawDescription: "UBER EATS BRISBANE" }),
			);

			const result = await searchTransactions(db, "mcdonald");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(1);
			expect(result.value[0]?.item).toBe("McDonald's");
		});

		it("matches by rawDescription", async () => {
			await createTransaction(
				db,
				accountId,
				makeCatTx({
					externalId: "tx-1",
					item: "McDonald's",
					rawDescription: "MCDONALDS SOUTH BRISBANE QLD",
				}),
			);
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-2", item: "Woolworths", rawDescription: "WOOLWORTHS 1234 ADELAIDE" }),
			);

			const result = await searchTransactions(db, "BRISBANE");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(1);
			expect(result.value[0]?.rawDescription).toContain("BRISBANE");
		});

		it("respects limit parameter", async () => {
			for (let i = 1; i <= 10; i++) {
				await createTransaction(db, accountId, makeCatTx({ externalId: `tx-${i}`, item: `Test Item ${i}` }));
			}

			const result = await searchTransactions(db, "test", 2);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(2);
		});

		it("returns empty array when no matches", async () => {
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-1" }));

			const result = await searchTransactions(db, "nothing");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value).toEqual([]);
		});
	});

	describe("getReportRows", () => {
		it("excludes rows marked excluded", async () => {
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-1", category: "Eating Out", amount: 10 }));
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-2", category: "Bills", amount: 20, excluded: true, excludeReason: "test" }),
			);

			const result = await getReportRows(db);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.length).toBe(1);
			expect(result.value[0]?.externalId).toBe("tx-1");
		});

		it("filters by date range and accountId", async () => {
			const acct2Result = await upsertAccount(db, "test", {
				id: "acc-2",
				name: "Savings Account",
				institution: "TestBank",
				type: "savings",
			});
			expect(acct2Result.ok).toBe(true);
			if (!acct2Result.ok) return;
			const account2Id = acct2Result.value.id;

			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-1", date: "2026-02-15", category: "Eating Out", amount: 100 }),
			);
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-2", date: "2026-03-05", category: "Eating Out", amount: 20 }),
			);
			await createTransaction(
				db,
				account2Id,
				makeCatTx({
					externalId: "tx-3",
					date: "2026-03-10",
					category: "Shopping",
					amount: 30,
					accountId: "acc-2",
				}),
			);

			const result = await getReportRows(db, { dateFrom: "2026-03-01", dateTo: "2026-03-31", accountId });
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.length).toBe(1);
			expect(result.value[0]?.externalId).toBe("tx-2");
		});

		it("returns ascending by date", async () => {
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-1", date: "2026-03-10" }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-2", date: "2026-03-01" }));

			const result = await getReportRows(db);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.map((r) => r.externalId)).toEqual(["tx-2", "tx-1"]);
		});

		it("returns empty array on empty database", async () => {
			const result = await getReportRows(db);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value).toEqual([]);
		});
	});

	describe("summarizeTransactions over seeded rows", () => {
		it("aggregates spend by category and includes income from a credit", async () => {
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-1", category: "Eating Out", amount: 10 }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-2", category: "Eating Out", amount: 20 }));
			await createTransaction(db, accountId, makeCatTx({ externalId: "tx-3", category: "Shopping", amount: 30 }));
			await createTransaction(
				db,
				accountId,
				makeCatTx({ externalId: "tx-4", category: "Income", direction: "credit", amount: 5000 }),
			);

			const rowsResult = await getReportRows(db);
			expect(rowsResult.ok).toBe(true);
			if (!rowsResult.ok) return;

			const summary = summarizeTransactions(rowsResult.value);
			const byCategory = Object.fromEntries(summary.spendByCategory.map((r) => [r.category, r]));

			expect(byCategory["Eating Out"]?.total).toBe(30);
			expect(byCategory["Eating Out"]?.count).toBe(2);
			expect(byCategory.Shopping?.total).toBe(30);
			expect(summary.income).toBe(5000);
			expect(summary.spend).toBe(60);
			expect(summary.savingsRate).not.toBeNull();
		});
	});
});

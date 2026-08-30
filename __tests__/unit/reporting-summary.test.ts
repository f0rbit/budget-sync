import { describe, expect, it } from "bun:test";
import { summarizeTransactions } from "../../src/reporting/summary.js";
import type { ReportTransaction } from "../../src/reporting/types.js";

function row(overrides: Partial<ReportTransaction>): ReportTransaction {
	return {
		date: "2026-03-01",
		amount: 10,
		direction: "debit",
		category: "Woolworths",
		item: "Woolworths",
		...overrides,
	};
}

describe("summarizeTransactions", () => {
	it("excludes Income/Refund from the spend breakdown", () => {
		const rows = [
			row({ category: "Woolworths", amount: 50 }),
			row({ direction: "credit", category: "Income", amount: 3000, item: "Salary" }),
			row({ direction: "credit", category: "Refund", amount: 20, item: "Osko" }),
		];

		const summary = summarizeTransactions(rows);

		expect(summary.spendByCategory).toEqual([{ category: "Woolworths", total: 50, count: 1 }]);
		expect(summary.spend).toBe(50);
		expect(summary.income).toBe(3000);
		expect(summary.refunds).toBe(20);
	});

	it("computes savings rate as (income - spend + refunds) / income", () => {
		const rows = [
			row({ category: "Woolworths", amount: 200 }),
			row({ direction: "credit", category: "Income", amount: 1000, item: "Salary" }),
			row({ direction: "credit", category: "Refund", amount: 50, item: "Osko" }),
		];

		const summary = summarizeTransactions(rows);

		// net = 1000 - 200 + 50 = 850; rate = 850 / 1000 = 0.85
		expect(summary.net).toBe(850);
		expect(summary.savingsRate).toBeCloseTo(0.85);
	});

	it("savings rate is null (not NaN/Infinity) when there is no income", () => {
		const rows = [row({ category: "Woolworths", amount: 50 })];

		const summary = summarizeTransactions(rows);

		expect(summary.savingsRate).toBeNull();
		expect(summary.income).toBe(0);
	});

	it("sorts spendByCategory descending by total", () => {
		const rows = [
			row({ category: "Woolworths", amount: 10 }),
			row({ category: "Bills", amount: 100 }),
			row({ category: "Eating Out", amount: 50 }),
		];

		const summary = summarizeTransactions(rows);

		expect(summary.spendByCategory.map((c) => c.category)).toEqual(["Bills", "Eating Out", "Woolworths"]);
	});

	it("returns zeroed totals for empty input", () => {
		const summary = summarizeTransactions([]);

		expect(summary.spendByCategory).toEqual([]);
		expect(summary.spend).toBe(0);
		expect(summary.income).toBe(0);
		expect(summary.refunds).toBe(0);
		expect(summary.net).toBe(0);
		expect(summary.savingsRate).toBeNull();
	});
});

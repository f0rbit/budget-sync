import { describe, expect, it } from "bun:test";
import { pivotMonthly } from "../../src/reporting/monthly.js";
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

describe("pivotMonthly", () => {
	it("returns months ascending with per-month totals", () => {
		const rows = [
			row({ date: "2026-04-01", category: "Woolworths", amount: 50 }),
			row({ date: "2026-03-01", category: "Bills", amount: 100 }),
		];

		const pivot = pivotMonthly(rows);

		expect(pivot.months.map((m) => m.month)).toEqual(["2026-03", "2026-04"]);
		expect(pivot.months[0]?.byCategory.Bills).toBe(100);
		expect(pivot.months[1]?.byCategory.Woolworths).toBe(50);
	});

	it("a category absent in a month yields no key for that month", () => {
		const rows = [
			row({ date: "2026-03-01", category: "Woolworths", amount: 50 }),
			row({ date: "2026-04-01", category: "Bills", amount: 100 }),
		];

		const pivot = pivotMonthly(rows);

		const march = pivot.months.find((m) => m.month === "2026-03");
		const april = pivot.months.find((m) => m.month === "2026-04");

		expect(march?.byCategory.Bills).toBeUndefined();
		expect(april?.byCategory.Woolworths).toBeUndefined();
	});

	it("categories are the union of spend categories seen, in CATEGORIES order", () => {
		const rows = [
			row({ date: "2026-03-01", category: "Bills", amount: 10 }),
			row({ date: "2026-03-01", category: "Woolworths", amount: 20 }),
		];

		const pivot = pivotMonthly(rows);

		// Woolworths precedes Bills in CATEGORIES
		expect(pivot.categories).toEqual(["Woolworths", "Bills"]);
	});

	it("income/refund credits contribute to monthly totals but not byCategory", () => {
		const rows = [
			row({ date: "2026-03-01", direction: "credit", category: "Income", amount: 3000, item: "Salary" }),
			row({ date: "2026-03-01", category: "Woolworths", amount: 50 }),
		];

		const pivot = pivotMonthly(rows);
		const march = pivot.months[0];

		expect(march?.income).toBe(3000);
		expect(march?.spend).toBe(50);
		expect(march?.byCategory.Income).toBeUndefined();
	});

	it("returns empty months/categories for empty input", () => {
		const pivot = pivotMonthly([]);

		expect(pivot.months).toEqual([]);
		expect(pivot.categories).toEqual([]);
	});
});

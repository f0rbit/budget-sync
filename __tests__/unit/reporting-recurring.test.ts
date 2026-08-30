import { describe, expect, it } from "bun:test";
import { detectRecurring } from "../../src/reporting/recurring.js";
import type { ReportTransaction } from "../../src/reporting/types.js";

function row(overrides: Partial<ReportTransaction>): ReportTransaction {
	return {
		date: "2026-01-01",
		amount: 10,
		direction: "debit",
		category: "Subscriptions",
		item: "Netflix",
		...overrides,
	};
}

describe("detectRecurring", () => {
	it("detects weekly cadence from ~7-day gaps", () => {
		const dates = [
			"2026-01-05",
			"2026-01-12",
			"2026-01-19",
			"2026-01-26",
			"2026-02-02",
			"2026-02-09",
			"2026-02-16",
			"2026-02-23",
			"2026-03-02",
		];
		const rows = dates.map((date) => row({ date, item: "Coffee Cart", category: "Eating Out", amount: 5 }));

		const [charge] = detectRecurring(rows, { minMonths: 3, asOf: "2026-03-02" });

		expect(charge?.cadence).toBe("weekly");
		expect(charge?.occurrences).toBe(9);
	});

	it("detects monthly cadence from ~30-day gaps", () => {
		const rows = [row({ date: "2026-01-01" }), row({ date: "2026-02-01" }), row({ date: "2026-03-01" })];

		const [charge] = detectRecurring(rows, { minMonths: 3, asOf: "2026-03-01" });

		expect(charge?.cadence).toBe("monthly");
	});

	it("drops groups that don't span at least minMonths distinct months", () => {
		const rows = [row({ date: "2026-01-01" }), row({ date: "2026-01-15" }), row({ date: "2026-02-01" })];

		const charges = detectRecurring(rows, { minMonths: 3, asOf: "2026-02-01" });

		expect(charges).toEqual([]);
	});

	it("median amount is resistant to a single outlier", () => {
		const rows = [
			row({ date: "2026-01-01", amount: 15 }),
			row({ date: "2026-02-01", amount: 15 }),
			row({ date: "2026-03-01", amount: 15 }),
			row({ date: "2026-04-01", amount: 100 }),
		];

		const [charge] = detectRecurring(rows, { minMonths: 3, asOf: "2026-04-01" });

		expect(charge?.typicalAmount).toBe(15);
	});

	it("is lapsed when asOf is ~2 cadence cycles after lastSeen", () => {
		const rows = [row({ date: "2026-01-01" }), row({ date: "2026-02-01" }), row({ date: "2026-03-01" })];

		const [charge] = detectRecurring(rows, { minMonths: 3, asOf: "2026-04-30" });

		expect(charge?.lastSeen).toBe("2026-03-01");
		expect(charge?.possiblyLapsed).toBe(true);
	});

	it("is not lapsed when asOf is ~1 cadence cycle after lastSeen", () => {
		const rows = [row({ date: "2026-01-01" }), row({ date: "2026-02-01" }), row({ date: "2026-03-01" })];

		const [charge] = detectRecurring(rows, { minMonths: 3, asOf: "2026-03-31" });

		expect(charge?.possiblyLapsed).toBe(false);
	});

	it("ignores credits (Income/Refund rows never become recurring charges)", () => {
		const rows = [
			row({ date: "2026-01-01", direction: "credit", category: "Income", item: "Salary" }),
			row({ date: "2026-02-01", direction: "credit", category: "Income", item: "Salary" }),
			row({ date: "2026-03-01", direction: "credit", category: "Income", item: "Salary" }),
		];

		const charges = detectRecurring(rows, { minMonths: 3, asOf: "2026-03-01" });

		expect(charges).toEqual([]);
	});

	it("returns [] for empty input", () => {
		expect(detectRecurring([], { minMonths: 3, asOf: "2026-03-01" })).toEqual([]);
	});
});

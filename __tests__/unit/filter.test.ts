import { describe, expect, it } from "bun:test";
import { filterTransaction, filterTransactions } from "../../src/pipeline/filter.js";
import type { ExclusionRule, RawTransaction } from "../../src/providers/types.js";
import { makeTransaction } from "../helpers.js";

const EXCLUSIONS: ExclusionRule[] = [
	{ match: "^To 460184", reason: "CC payment" },
	{ match: "BETASHARES DIRECT", reason: "Investment transfer" },
	{ match: "RENT MR MAXWELL", reason: "Roommate rent deposit" },
	{ match: "Internal Transfer.*Savings", reason: "Savings transfer" },
];

describe("filterTransaction", () => {
	it("passes through credit transactions (no longer blanket-excluded)", () => {
		const tx = makeTransaction({ direction: "credit", description: "SALARY PAYMENT" });
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(tx);
		}
	});

	it("excludes a credit matching an exclusion regex the same as a debit would", () => {
		const tx = makeTransaction({
			direction: "credit",
			description: "BETASHARES DIRECT Sell",
		});
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("Investment transfer");
		}
	});

	it("passes through debit spending transactions", () => {
		const tx = makeTransaction({ direction: "debit", description: "WOOLWORTHS 1234" });
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(tx);
		}
	});

	it("excludes CC payment pattern", () => {
		const tx = makeTransaction({ direction: "debit", description: "To 460184XXXXXXXX" });
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("CC payment");
		}
	});

	it("excludes savings transfer pattern", () => {
		const tx = makeTransaction({
			direction: "debit",
			description: "Internal Transfer to Savings Goal",
		});
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("Savings transfer");
		}
	});

	it("excludes investment pattern (BETASHARES DIRECT)", () => {
		const tx = makeTransaction({
			direction: "debit",
			description: "BETASHARES DIRECT Purchase",
		});
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("Investment transfer");
		}
	});

	it("excludes roommate rent deposit (RENT MR MAXWELL)", () => {
		const tx = makeTransaction({
			direction: "debit",
			description: "RENT MR MAXWELL Weekly",
		});
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("Roommate rent deposit");
		}
	});

	it("passes debit transaction with no matching exclusion pattern", () => {
		const tx = makeTransaction({
			direction: "debit",
			description: "COLES EXPRESS 5678 MELBOURNE",
		});
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(tx);
		}
	});

	it("matches exclusion patterns case-insensitively", () => {
		const tx = makeTransaction({
			direction: "debit",
			description: "betashares direct etf",
		});
		const result = filterTransaction(tx, EXCLUSIONS);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("Investment transfer");
		}
	});
});

describe("filterTransactions", () => {
	it("partitions transactions into passed and excluded", () => {
		const debit = makeTransaction({ direction: "debit", description: "COFFEE SHOP" });
		const credit = makeTransaction({ direction: "credit", description: "REFUND" });
		const excluded_pattern = makeTransaction({
			direction: "debit",
			description: "BETASHARES DIRECT Buy",
		});

		const { passed, excluded } = filterTransactions([debit, credit, excluded_pattern], EXCLUSIONS);

		expect(passed).toHaveLength(2);
		expect(passed).toContain(debit);
		expect(passed).toContain(credit);
		expect(excluded).toHaveLength(1);
		expect(excluded.map((e) => e.externalId)).toContain(excluded_pattern.id);
	});

	it("returns empty arrays for empty input", () => {
		const { passed, excluded } = filterTransactions([], EXCLUSIONS);

		expect(passed).toHaveLength(0);
		expect(excluded).toHaveLength(0);
	});
});

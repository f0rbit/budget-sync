import { describe, expect, it } from "bun:test";
import { type DedupCandidate, MAX_DAY_GAP, detectCrossAccountDuplicates } from "../../src/pipeline/dedup.js";
import { makeCategorizedTransaction } from "../helpers.js";

function makeCandidate(overrides?: Partial<DedupCandidate>): DedupCandidate {
	return {
		id: "existing-1",
		accountId: "cc-account",
		accountType: "credit",
		date: "2026-02-28",
		item: "Officeworks",
		amount: 42.5,
		excluded: false,
		...overrides,
	};
}

describe("detectCrossAccountDuplicates", () => {
	it("excludes lower-priority incoming on exact match", () => {
		const existing = [makeCandidate()];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 42.5,
				date: "2026-03-02",
				accountId: "savings-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.kept).toHaveLength(0);
		expect(result.duplicates).toHaveLength(1);
		expect(result.duplicates[0]?.reason).toContain("Cross-account duplicate");
	});

	it("keeps incoming when amounts differ", () => {
		const existing = [makeCandidate({ amount: 42.5 })];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 39.99,
				date: "2026-03-01",
				accountId: "savings-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(0);
	});

	it("keeps incoming when items differ despite same amount", () => {
		const existing = [makeCandidate({ item: "Uber One", amount: 9.99 })];
		const incoming = [
			makeCategorizedTransaction({
				item: "Amazon Prime",
				amount: 9.99,
				date: "2026-03-01",
				accountId: "savings-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(0);
	});

	it("keeps incoming when date gap exceeds MAX_DAY_GAP", () => {
		const existing = [makeCandidate({ date: "2026-02-20" })];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 42.5,
				date: "2026-03-02",
				accountId: "savings-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(0);
	});

	it("keeps incoming when both are on the same account", () => {
		const existing = [makeCandidate({ accountId: "shared-account" })];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 42.5,
				date: "2026-03-01",
				accountId: "shared-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(0);
	});

	it("excludes savings incoming when existing is credit (higher priority)", () => {
		const existing = [makeCandidate({ accountType: "credit" })];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 42.5,
				date: "2026-03-01",
				accountId: "savings-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.duplicates).toHaveLength(1);
		expect(result.duplicates[0]?.reason).toContain("Cross-account duplicate");
	});

	it("keeps incoming when it has higher priority than existing", () => {
		const existing = [makeCandidate({ accountType: "savings" })];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 42.5,
				date: "2026-03-01",
				accountId: "cc-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "credit");

		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(0);
	});

	it("passes through credit-direction transactions without dedup check", () => {
		const existing = [makeCandidate()];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 42.5,
				date: "2026-03-01",
				direction: "credit",
				accountId: "savings-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(0);
	});

	it("ignores already-excluded existing candidates", () => {
		const existing = [makeCandidate({ excluded: true })];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 42.5,
				date: "2026-03-01",
				accountId: "savings-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(0);
	});

	it("picks the closest date when multiple candidates match", () => {
		const existing = [
			makeCandidate({ id: "far-match", date: "2026-02-25" }),
			makeCandidate({ id: "close-match", date: "2026-02-28" }),
		];
		const incoming = [
			makeCategorizedTransaction({
				item: "Officeworks",
				amount: 42.5,
				date: "2026-03-01",
				accountId: "savings-account",
			}),
		];

		const result = detectCrossAccountDuplicates(incoming, existing, "savings");

		expect(result.duplicates).toHaveLength(1);
		expect(result.duplicates[0]?.reason).toContain("2026-02-28");
	});
});

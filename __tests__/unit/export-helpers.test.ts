import { describe, expect, it } from "bun:test";
import { renderNote, slugify } from "../../src/services/export-service.js";
import type { TransactionRow } from "../../src/services/transaction-service.js";

function makeTxRow(overrides?: Partial<TransactionRow>): TransactionRow {
	return {
		id: "tx-1",
		accountId: "acc-1",
		externalId: "ext-1",
		date: "2026-03-01",
		postDate: null,
		rawDescription: "WOOLWORTHS 1234 ADELAIDE SA",
		item: "Woolworths",
		amount: 42.5,
		direction: "debit" as const,
		category: "Woolworths",
		notes: null,
		excluded: false,
		excludeReason: null,
		syncRunId: null,
		createdAt: new Date("2026-03-01"),
		...overrides,
	};
}

describe("slugify", () => {
	it("lowercases basic text", () => {
		expect(slugify("Woolworths")).toBe("woolworths");
	});

	it("replaces spaces and special chars with hyphens", () => {
		expect(slugify("Eating Out & More!")).toBe("eating-out-more");
	});

	it("strips straight apostrophes", () => {
		expect(slugify("McDonald's")).toBe("mcdonalds");
	});

	it("replaces curly apostrophes with hyphens", () => {
		// The regex only strips straight apostrophes (U+0027), curly ones become hyphens
		expect(slugify("McDonald\u2019s")).toBe("mcdonald-s");
	});

	it("trims leading and trailing hyphens", () => {
		expect(slugify("---hello world---")).toBe("hello-world");
	});

	it("truncates to 50 characters", () => {
		expect(slugify("a".repeat(100))).toBe("a".repeat(50));
	});

	it("collapses multiple consecutive separators", () => {
		expect(slugify("a   b   c")).toBe("a-b-c");
	});

	it("returns empty string for empty input", () => {
		expect(slugify("")).toBe("");
	});
});

describe("renderNote", () => {
	it("renders basic note with frontmatter and body", () => {
		const result = renderNote(makeTxRow());

		expect(result).toStartWith("---\n");
		expect(result).toContain("date: 2026-03-01");
		expect(result).toContain('item: "Woolworths"');
		expect(result).toContain("amount: 42.50");
		expect(result).toContain('category: "Woolworths"');
		expect(result).toContain("direction: debit");
		expect(result).not.toContain("post_date");
		expect(result).toContain("# Woolworths");
		expect(result).toContain("**$42.50** \u2014 Woolworths");
		expect(result).toContain("> WOOLWORTHS 1234 ADELAIDE SA");
	});

	it("includes post_date when postDate is set", () => {
		const result = renderNote(makeTxRow({ postDate: "2026-03-02" }));

		expect(result).toContain("post_date: 2026-03-02");
	});

	it("includes notes in frontmatter and body", () => {
		const result = renderNote(makeTxRow({ notes: "Location: Adelaide" }));

		expect(result).toContain('notes: "Location: Adelaide"');
		expect(result).toContain("Location: Adelaide");
	});

	it("includes excluded and exclude_reason", () => {
		const result = renderNote(makeTxRow({ excluded: true, excludeReason: "CC payment" }));

		expect(result).toContain("excluded: true");
		expect(result).toContain('exclude_reason: "CC payment"');
	});
});

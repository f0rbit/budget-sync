import { describe, expect, it } from "bun:test";
import type { RentConfig } from "../../src/config.js";
import {
	type PipelineContext,
	type PipelineOutput,
	categorizeAll,
	categorizePipeline,
} from "../../src/pipeline/categorizer.js";
import type { ExclusionRule, MerchantMapping, RawTransaction } from "../../src/providers/types.js";
import { makeRentConfig, makeTransaction } from "../helpers.js";

function makeContext(overrides?: {
	mappings?: MerchantMapping[];
	exclusions?: ExclusionRule[];
	rentConfig?: RentConfig;
}): PipelineContext {
	return {
		mappings: {
			mappings: overrides?.mappings ?? [],
			exclusions: overrides?.exclusions ?? [],
		},
		rentConfig: overrides?.rentConfig ?? makeRentConfig(),
	};
}

describe("categorizePipeline", () => {
	it("categorizes transaction matching a merchant mapping", async () => {
		const tx = makeTransaction({
			description: "WOOLWORTHS/1234 BRISBANE",
			direction: "debit",
		});
		const ctx = makeContext({
			mappings: [{ match: "WOOLWORTHS/", item: "Woolworths", category: "Woolworths", extractLocation: true }],
		});

		const result = await categorizePipeline(tx, ctx);

		expect(result.type).toBe("categorized");
		if (result.type === "categorized") {
			expect(result.transaction.item).toBe("Woolworths");
			expect(result.transaction.category).toBe("Woolworths");
			expect(result.transaction.excluded).toBe(false);
		}
	});

	it("categorizes rent transaction with Rent category", async () => {
		const tx = makeTransaction({
			description: "IPY*GRACZYKTHOMPSON Weekly Rent",
			direction: "debit",
			transactionDate: "2026-03-15",
			amount: 1200,
		});
		const ctx = makeContext();

		const result = await categorizePipeline(tx, ctx);

		expect(result.type).toBe("categorized");
		if (result.type === "categorized") {
			expect(result.transaction.category).toBe("Rent");
			expect(result.transaction.item).toBe("Rent");
			expect(result.transaction.amount).toBe(650); // solo weekly amount
		}
	});

	it("categorizes unknown merchant as Other", async () => {
		const tx = makeTransaction({
			description: "RANDOM MERCHANT ABC 123",
			direction: "debit",
		});
		const ctx = makeContext();

		const result = await categorizePipeline(tx, ctx);

		expect(result.type).toBe("categorized");
		if (result.type === "categorized") {
			expect(result.transaction.category).toBe("Other");
			expect(result.transaction.item).toBe("RANDOM MERCHANT ABC 123");
		}
	});

	it("excludes filtered transactions", async () => {
		const tx = makeTransaction({
			description: "BETASHARES DIRECT Purchase",
			direction: "debit",
		});
		const ctx = makeContext({
			exclusions: [{ match: "BETASHARES DIRECT", reason: "Investment transfer" }],
		});

		const result = await categorizePipeline(tx, ctx);

		expect(result.type).toBe("excluded");
		if (result.type === "excluded") {
			expect(result.transaction.reason).toBe("Investment transfer");
			expect(result.transaction.externalId).toBe(tx.id);
		}
	});

	it("excludes credit transactions before checking other rules", async () => {
		const tx = makeTransaction({
			description: "WOOLWORTHS/REFUND",
			direction: "credit",
		});
		const ctx = makeContext({
			mappings: [{ match: "WOOLWORTHS/", item: "Woolworths", category: "Woolworths" }],
		});

		const result = await categorizePipeline(tx, ctx);

		expect(result.type).toBe("excluded");
		if (result.type === "excluded") {
			expect(result.transaction.reason).toBe("Credit transaction (incoming money)");
		}
	});

	it("prefers rent over merchant mapping when both match", async () => {
		const tx = makeTransaction({
			description: "IPY*GRACZYKTHOMPSON",
			direction: "debit",
			transactionDate: "2026-03-15",
		});
		const ctx = makeContext({
			mappings: [{ match: "IPY*GRACZYKTHOMPSON", item: "Some Mapping", category: "Other" }],
		});

		const result = await categorizePipeline(tx, ctx);

		expect(result.type).toBe("categorized");
		if (result.type === "categorized") {
			expect(result.transaction.category).toBe("Rent");
			expect(result.transaction.item).toBe("Rent");
		}
	});

	it("uses inline enrichment when no local mapping matches", async () => {
		const tx = makeTransaction({
			description: "UNKNOWN RESTAURANT PTY LTD",
			direction: "debit",
			enrichment: {
				merchantName: "The Local Bistro",
				category: "Restaurants",
				location: "123 Main St",
			},
		});
		const ctx = makeContext();

		const result = await categorizePipeline(tx, ctx);

		expect(result.type).toBe("categorized");
		if (result.type === "categorized") {
			expect(result.transaction.category).toBe("Eating Out");
			expect(result.transaction.item).toBe("The Local Bistro");
			expect(result.transaction.notes).toContain("123 Main St");
		}
	});
});

describe("categorizeAll", () => {
	it("partitions transactions into categorized and excluded", async () => {
		const debit = makeTransaction({ description: "RANDOM SHOP", direction: "debit" });
		const credit = makeTransaction({ description: "SALARY", direction: "credit" });
		const rent = makeTransaction({
			description: "IPY*GRACZYKTHOMPSON",
			direction: "debit",
			transactionDate: "2026-03-15",
		});

		const ctx = makeContext();
		const { categorized, excluded } = await categorizeAll([debit, credit, rent], ctx);

		expect(categorized).toHaveLength(2);
		expect(excluded).toHaveLength(1);

		const categories = categorized.map((t) => t.category);
		expect(categories).toContain("Other");
		expect(categories).toContain("Rent");

		expect(excluded[0]?.externalId).toBe(credit.id);
	});

	it("returns empty arrays for empty input", async () => {
		const ctx = makeContext();
		const { categorized, excluded } = await categorizeAll([], ctx);

		expect(categorized).toHaveLength(0);
		expect(excluded).toHaveLength(0);
	});
});

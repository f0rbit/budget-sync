import { describe, expect, it } from "bun:test";
import { type PipelineContext, categorizeAll, categorizePipeline } from "../../src/pipeline/categorizer.js";
import { loadMappings } from "../../src/pipeline/local-mappings.js";
import type { MerchantMappings, RawTransaction } from "../../src/providers/types.js";
import { makeRentConfig } from "../helpers.js";

// Load real merchant mappings once for all tests
function loadTestMappings(): MerchantMappings {
	const result = loadMappings();
	if (!result.ok) throw new Error(`Failed to load mappings: ${result.error.message}`);
	return result.value;
}

function makePipelineContext(overrides?: Partial<PipelineContext>): PipelineContext {
	return {
		mappings: loadTestMappings(),
		rentConfig: makeRentConfig(),
		...overrides,
	};
}

function tx(overrides: Partial<RawTransaction> & { id: string; description: string }): RawTransaction {
	return {
		amount: 25.0,
		direction: "debit",
		transactionDate: "2026-03-05",
		postDate: "2026-03-05",
		accountId: "acc-1",
		...overrides,
	};
}

describe("categorization pipeline", () => {
	it("matches known merchant mapping to correct category and item", async () => {
		const ctx = makePipelineContext();
		const raw = tx({ id: "tx-1", description: "MCDONALDS SOUTH BRISBANE" });

		const result = await categorizePipeline(raw, ctx);

		expect(result.type).toBe("categorized");
		if (result.type !== "categorized") return;
		expect(result.transaction.category).toBe("Eating Out");
		expect(result.transaction.item).toBe("McDonald's");
		expect(result.transaction.excluded).toBe(false);
	});

	it("Woolworths with extractLocation includes location in notes", async () => {
		const ctx = makePipelineContext();
		const raw = tx({ id: "tx-2", description: "WOOLWORTHS/1234 BRISBANE" });

		const result = await categorizePipeline(raw, ctx);

		expect(result.type).toBe("categorized");
		if (result.type !== "categorized") return;
		expect(result.transaction.category).toBe("Woolworths");
		expect(result.transaction.item).toBe("Woolworths");
		expect(result.transaction.notes).toContain("BRISBANE");
	});

	it("unknown merchant falls back to Other category", async () => {
		const ctx = makePipelineContext();
		const raw = tx({ id: "tx-3", description: "RANDOM STORE NOBODY KNOWS" });

		const result = await categorizePipeline(raw, ctx);

		expect(result.type).toBe("categorized");
		if (result.type !== "categorized") return;
		expect(result.transaction.category).toBe("Other");
		expect(result.transaction.item).toBe("RANDOM STORE NOBODY KNOWS");
	});

	it("credit card payment exclusion rule filters correctly", async () => {
		const ctx = makePipelineContext();
		const raw = tx({
			id: "tx-4",
			description: "To 460184 Credit Card Payment",
			amount: 500,
			direction: "debit",
		});

		const result = await categorizePipeline(raw, ctx);

		expect(result.type).toBe("excluded");
		if (result.type !== "excluded") return;
		expect(result.transaction.reason).toBe("Credit card payment");
	});

	it("savings transfer exclusion rule filters correctly", async () => {
		const ctx = makePipelineContext();
		const raw = tx({
			id: "tx-5",
			description: "To 131007 Savings Goal",
			amount: 200,
			direction: "debit",
		});

		const result = await categorizePipeline(raw, ctx);

		expect(result.type).toBe("excluded");
		if (result.type !== "excluded") return;
		expect(result.transaction.reason).toBe("Savings transfer");
	});

	it("credit transactions are excluded", async () => {
		const ctx = makePipelineContext();
		const raw = tx({
			id: "tx-6",
			description: "SALARY PAYMENT",
			amount: 3000,
			direction: "credit",
		});

		const result = await categorizePipeline(raw, ctx);

		expect(result.type).toBe("excluded");
		if (result.type !== "excluded") return;
		expect(result.transaction.reason).toContain("Credit");
	});

	it("rent transaction before solo_start_date uses shared calculation", async () => {
		const ctx = makePipelineContext();
		// solo_start_date is 2026-03-01, so Feb date is shared
		const raw = tx({
			id: "tx-7",
			description: "IPY*GRACZYKTHOMPSON Feb Rent",
			amount: 1100,
			direction: "debit",
			transactionDate: "2026-02-15",
			postDate: "2026-02-15",
		});

		const result = await categorizePipeline(raw, ctx);

		expect(result.type).toBe("categorized");
		if (result.type !== "categorized") return;
		expect(result.transaction.category).toBe("Rent");
		expect(result.transaction.item).toBe("Rent");
		// shared = amount - roommate_contribution = 1100 - 450 = 650
		expect(result.transaction.amount).toBe(650);
		expect(result.transaction.notes).toContain("Shared rent");
		expect(result.transaction.notes).toContain("450");
	});

	it("rent transaction after solo_start_date uses solo weekly amount", async () => {
		const ctx = makePipelineContext();
		// solo_start_date is 2026-03-01, so March date is solo
		const raw = tx({
			id: "tx-8",
			description: "IPY*GRACZYKTHOMPSON Mar Rent",
			amount: 1300,
			direction: "debit",
			transactionDate: "2026-03-15",
			postDate: "2026-03-15",
		});

		const result = await categorizePipeline(raw, ctx);

		expect(result.type).toBe("categorized");
		if (result.type !== "categorized") return;
		expect(result.transaction.category).toBe("Rent");
		expect(result.transaction.amount).toBe(650); // solo_weekly_amount
		expect(result.transaction.notes).toContain("Solo rent");
	});

	it("categorizeAll partitions into categorized and excluded arrays", async () => {
		const ctx = makePipelineContext();
		const rawTxs: RawTransaction[] = [
			tx({ id: "tx-a", description: "MCDONALDS BRISBANE" }),
			tx({ id: "tx-b", description: "SALARY DEPOSIT", direction: "credit", amount: 5000 }),
			tx({ id: "tx-c", description: "UNKNOWN SHOP XYZ" }),
		];

		const { categorized, excluded } = await categorizeAll(rawTxs, ctx);

		expect(categorized.length).toBe(2);
		expect(excluded.length).toBe(1);
		expect(excluded[0]?.externalId).toBe("tx-b");
	});
});

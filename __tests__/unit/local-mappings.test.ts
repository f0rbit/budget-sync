import { describe, expect, it } from "bun:test";
import { applyMapping, matchTransaction } from "../../src/pipeline/local-mappings.js";
import type { MerchantMapping } from "../../src/providers/types.js";
import { makeTransaction } from "../helpers.js";

const MAPPINGS: MerchantMapping[] = [
	{ match: "WOOLWORTHS/", item: "Woolworths", category: "Woolworths", extractLocation: true },
	{ match: "COLES ", item: "Coles", category: "Woolworths" },
	{ match: "UBER* EATS", item: "Uber Eats", category: "Eating Out" },
	{ match: "NETFLIX", item: "Netflix", category: "Subscriptions" },
];

describe("matchTransaction", () => {
	it("matches exact substring (WOOLWORTHS/1234 BRISBANE)", () => {
		const result = matchTransaction("WOOLWORTHS/1234 BRISBANE QLD", MAPPINGS);

		expect(result).not.toBeNull();
		expect(result?.item).toBe("Woolworths");
		expect(result?.category).toBe("Woolworths");
	});

	it("matches case-insensitively", () => {
		const result = matchTransaction("woolworths/5678 melbourne", MAPPINGS);

		expect(result).not.toBeNull();
		expect(result?.item).toBe("Woolworths");
	});

	it("first match wins when multiple could match", () => {
		// Both "WOOLWORTHS/" and potentially others won't match, but let's create
		// a scenario where order matters
		const overlapping: MerchantMapping[] = [
			{ match: "UBER", item: "Uber Rides", category: "Transport" },
			{ match: "UBER* EATS", item: "Uber Eats", category: "Eating Out" },
		];

		const result = matchTransaction("UBER* EATS ORDER #123", overlapping);

		expect(result).not.toBeNull();
		expect(result?.item).toBe("Uber Rides"); // first match wins
	});

	it("returns null for no match", () => {
		const result = matchTransaction("RANDOM SHOP 123", MAPPINGS);

		expect(result).toBeNull();
	});

	it("returns null for empty mappings array", () => {
		const result = matchTransaction("WOOLWORTHS/1234", []);

		expect(result).toBeNull();
	});
});

describe("applyMapping", () => {
	it("creates a categorized transaction from mapping", () => {
		const tx = makeTransaction({
			description: "NETFLIX.COM AUD",
			amount: 22.99,
		});
		const mapping: MerchantMapping = {
			match: "NETFLIX",
			item: "Netflix",
			category: "Subscriptions",
		};

		const result = applyMapping(tx, mapping);

		expect(result.externalId).toBe(tx.id);
		expect(result.date).toBe(tx.transactionDate);
		expect(result.postDate).toBe(tx.postDate);
		expect(result.rawDescription).toBe("NETFLIX.COM AUD");
		expect(result.item).toBe("Netflix");
		expect(result.amount).toBe(22.99);
		expect(result.direction).toBe(tx.direction);
		expect(result.category).toBe("Subscriptions");
		expect(result.notes).toBe("");
		expect(result.excluded).toBe(false);
		expect(result.accountId).toBe(tx.accountId);
	});

	it("extracts location when extractLocation is true", () => {
		const tx = makeTransaction({
			description: "WOOLWORTHS/1234 BRISBANE QLD",
		});
		const mapping: MerchantMapping = {
			match: "WOOLWORTHS/",
			item: "Woolworths",
			category: "Woolworths",
			extractLocation: true,
		};

		const result = applyMapping(tx, mapping);

		expect(result.item).toBe("Woolworths");
		// After "WOOLWORTHS/" comes "1234 BRISBANE QLD"
		// The code strips leading digits: "BRISBANE QLD"
		expect(result.notes).toBe("BRISBANE QLD");
	});

	it("does not extract location when extractLocation is false/undefined", () => {
		const tx = makeTransaction({
			description: "COLES 5678 MELBOURNE VIC",
		});
		const mapping: MerchantMapping = {
			match: "COLES ",
			item: "Coles",
			category: "Woolworths",
		};

		const result = applyMapping(tx, mapping);

		expect(result.notes).toBe("");
	});

	it("handles extractLocation when no text follows the match", () => {
		const tx = makeTransaction({
			description: "WOOLWORTHS/",
		});
		const mapping: MerchantMapping = {
			match: "WOOLWORTHS/",
			item: "Woolworths",
			category: "Woolworths",
			extractLocation: true,
		};

		const result = applyMapping(tx, mapping);

		// No text after match, so notes should be empty
		expect(result.notes).toBe("");
	});
});

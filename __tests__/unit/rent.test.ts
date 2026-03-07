import { describe, expect, it } from "bun:test";
import type { RentConfig } from "../../src/config.js";
import { calculateRentAmount, handleRent, isRentTransaction } from "../../src/pipeline/rent.js";
import { makeRentConfig, makeTransaction } from "../helpers.js";

const RENT_CONFIG: RentConfig = makeRentConfig();
// solo_start_date: "2026-03-01"
// solo_weekly_amount: 650
// shared_roommate_contribution: 450
// landlord_patterns: ["IPY*GRACZYKTHOMPSON"]
// debit_rent_patterns: ["Internet Withdrawal.*Rent"]

describe("isRentTransaction", () => {
	it("detects landlord pattern match (IPY*GRACZYKTHOMPSON)", () => {
		const tx = makeTransaction({ description: "IPY*GRACZYKTHOMPSON Rent Payment" });
		expect(isRentTransaction(tx, RENT_CONFIG)).toBe(true);
	});

	it("matches landlord pattern case-insensitively", () => {
		const tx = makeTransaction({ description: "ipy*graczykthompson weekly" });
		expect(isRentTransaction(tx, RENT_CONFIG)).toBe(true);
	});

	it("detects debit rent pattern match (Internet Withdrawal Rent)", () => {
		const tx = makeTransaction({ description: "Internet Withdrawal Rent March" });
		expect(isRentTransaction(tx, RENT_CONFIG)).toBe(true);
	});

	it("does not match non-rent transaction", () => {
		const tx = makeTransaction({ description: "WOOLWORTHS 1234 ADELAIDE" });
		expect(isRentTransaction(tx, RENT_CONFIG)).toBe(false);
	});

	it("does not match partial keyword without pattern context", () => {
		const tx = makeTransaction({ description: "Rent-a-Car HERTZ" });
		expect(isRentTransaction(tx, RENT_CONFIG)).toBe(false);
	});
});

describe("calculateRentAmount", () => {
	it("returns solo_weekly_amount for transactions on or after solo_start_date", () => {
		const tx = makeTransaction({
			transactionDate: "2026-03-15",
			amount: 1200,
		});
		expect(calculateRentAmount(tx, RENT_CONFIG)).toBe(650);
	});

	it("returns solo_weekly_amount for transactions exactly on solo_start_date", () => {
		const tx = makeTransaction({
			transactionDate: "2026-03-01",
			amount: 1200,
		});
		expect(calculateRentAmount(tx, RENT_CONFIG)).toBe(650);
	});

	it("returns amount minus shared_roommate_contribution before solo_start_date", () => {
		const tx = makeTransaction({
			transactionDate: "2026-02-15",
			amount: 1200,
		});
		// 1200 - 450 = 750
		expect(calculateRentAmount(tx, RENT_CONFIG)).toBe(750);
	});
});

describe("handleRent", () => {
	it("returns categorized transaction with category Rent (solo period)", () => {
		const tx = makeTransaction({
			description: "IPY*GRACZYKTHOMPSON",
			transactionDate: "2026-03-15",
			amount: 1200,
		});
		const result = handleRent(tx, RENT_CONFIG);

		expect(result.externalId).toBe(tx.id);
		expect(result.date).toBe("2026-03-15");
		expect(result.postDate).toBe(tx.postDate);
		expect(result.rawDescription).toBe("IPY*GRACZYKTHOMPSON");
		expect(result.item).toBe("Rent");
		expect(result.amount).toBe(650);
		expect(result.direction).toBe(tx.direction);
		expect(result.category).toBe("Rent");
		expect(result.notes).toContain("Solo rent");
		expect(result.notes).toContain("$650/week");
		expect(result.excluded).toBe(false);
		expect(result.accountId).toBe(tx.accountId);
	});

	it("returns categorized transaction with category Rent (shared period)", () => {
		const tx = makeTransaction({
			description: "Internet Withdrawal Rent Feb",
			transactionDate: "2026-02-10",
			amount: 1000,
		});
		const result = handleRent(tx, RENT_CONFIG);

		expect(result.category).toBe("Rent");
		expect(result.item).toBe("Rent");
		expect(result.amount).toBe(550); // 1000 - 450
		expect(result.notes).toContain("Shared rent");
		expect(result.notes).toContain("$1000");
		expect(result.notes).toContain("$450");
	});
});

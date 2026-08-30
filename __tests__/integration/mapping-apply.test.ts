import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../../src/db/client.js";
import type { CategorizedTransaction, ExclusionRule, MerchantMapping } from "../../src/providers/types.js";
import { upsertAccount } from "../../src/services/account-service.js";
import { applyMappingsPlan, planMappingsApply } from "../../src/services/mapping-apply-service.js";
import { createTransaction, getTransactions } from "../../src/services/transaction-service.js";
import { createTestContext } from "../helpers.js";

function makeCatTx(overrides: Partial<CategorizedTransaction> & { externalId: string }): CategorizedTransaction {
	return {
		date: "2026-03-05",
		postDate: "2026-03-05",
		rawDescription: "TEST TRANSACTION",
		item: "Test Item",
		amount: 25.0,
		direction: "debit",
		category: "Other",
		notes: "",
		excluded: false,
		accountId: "acc-1",
		...overrides,
	};
}

const mappings: MerchantMapping[] = [{ match: "BEEM", item: "Beem Payment", category: "Shopping" }];

const exclusions: ExclusionRule[] = [{ match: "To 1310068128040", reason: "Savings → Everyday transfer" }];

describe("mapping-apply-service", () => {
	let db: AppDatabase;
	let accountId: string;

	beforeEach(async () => {
		const ctx = createTestContext();
		db = ctx.db;
		const result = await upsertAccount(db, "test", {
			id: "acc-1",
			name: "Test Account",
			institution: "TestBank",
			type: "transaction",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		accountId = result.value.id;
	});

	it("excludes rows matching an exclusion rule and recategorizes 'Other' rows matching a mapping", async () => {
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-1", rawDescription: "Internet Transfer To 1310068128040", amount: 1000 }),
		);
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-2", rawDescription: "Eftpos Beem Debit", category: "Other" }),
		);
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-3", rawDescription: "Woolworths Metro", category: "Woolworths" }),
		);

		const rowsResult = await getTransactions(db);
		expect(rowsResult.ok).toBe(true);
		if (!rowsResult.ok) return;

		const plan = planMappingsApply(rowsResult.value, mappings, exclusions);
		expect(plan.scanned).toBe(3);
		expect(plan.changes).toHaveLength(2);

		const excluded = plan.changes.find((c) => c.type === "excluded");
		expect(excluded?.type).toBe("excluded");
		if (excluded?.type === "excluded") expect(excluded.reason).toBe("Savings → Everyday transfer");

		const recategorized = plan.changes.find((c) => c.type === "recategorized");
		expect(recategorized?.type).toBe("recategorized");
		if (recategorized?.type === "recategorized") {
			expect(recategorized.category).toBe("Shopping");
			expect(recategorized.item).toBe("Beem Payment");
		}

		const applyResult = await applyMappingsPlan(db, plan);
		expect(applyResult.ok).toBe(true);

		const after = await getTransactions(db);
		expect(after.ok).toBe(true);
		if (!after.ok) return;

		const savings = after.value.find((r) => r.externalId === "tx-1");
		expect(savings?.excluded).toBe(true);
		expect(savings?.excludeReason).toBe("Savings → Everyday transfer");

		const beem = after.value.find((r) => r.externalId === "tx-2");
		expect(beem?.category).toBe("Shopping");
		expect(beem?.item).toBe("Beem Payment");

		const woolworths = after.value.find((r) => r.externalId === "tx-3");
		expect(woolworths?.category).toBe("Woolworths");
	});

	it("does not recategorize non-'Other' rows unless --force is set", async () => {
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-1", rawDescription: "Eftpos Beem Debit", category: "Entertainment" }),
		);

		const rowsResult = await getTransactions(db);
		expect(rowsResult.ok).toBe(true);
		if (!rowsResult.ok) return;

		const planNoForce = planMappingsApply(rowsResult.value, mappings, exclusions);
		expect(planNoForce.changes).toHaveLength(0);

		const planForce = planMappingsApply(rowsResult.value, mappings, exclusions, { force: true });
		expect(planForce.changes).toHaveLength(1);
	});

	it("dry-run planning does not touch the database", async () => {
		await createTransaction(
			db,
			accountId,
			makeCatTx({ externalId: "tx-1", rawDescription: "Eftpos Beem Debit", category: "Other" }),
		);

		const rowsResult = await getTransactions(db);
		expect(rowsResult.ok).toBe(true);
		if (!rowsResult.ok) return;

		planMappingsApply(rowsResult.value, mappings, exclusions);

		const after = await getTransactions(db);
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.value[0]?.category).toBe("Other");
	});

	it("recategorizes an unmapped credit (Income + flag note) once a mapping exists, clearing the note", async () => {
		await createTransaction(
			db,
			accountId,
			makeCatTx({
				externalId: "tx-1",
				rawDescription: "SALARY ACME CORP",
				direction: "credit",
				category: "Income",
				notes: "unmapped credit — verify",
			}),
		);

		const salaryMappings: MerchantMapping[] = [{ match: "SALARY ACME", item: "Salary", category: "Income" }];

		const rowsResult = await getTransactions(db);
		expect(rowsResult.ok).toBe(true);
		if (!rowsResult.ok) return;

		const plan = planMappingsApply(rowsResult.value, salaryMappings, exclusions);
		expect(plan.changes).toHaveLength(1);
		const [change] = plan.changes;
		expect(change?.type).toBe("recategorized");

		const applyResult = await applyMappingsPlan(db, plan);
		expect(applyResult.ok).toBe(true);

		const after = await getTransactions(db);
		expect(after.ok).toBe(true);
		if (!after.ok) return;

		const salary = after.value.find((r) => r.externalId === "tx-1");
		expect(salary?.category).toBe("Income");
		expect(salary?.item).toBe("Salary");
		expect(salary?.notes).toBe("");
	});
});

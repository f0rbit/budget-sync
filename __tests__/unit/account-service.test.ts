import { beforeEach, describe, expect, it } from "bun:test";
import { type AppDatabase, createTestDb } from "../../src/db/client.js";
import { deactivateAccount, listAccounts, upsertAccount } from "../../src/services/account-service.js";

describe("deactivateAccount", () => {
	let db: AppDatabase;

	beforeEach(() => {
		db = createTestDb();
	});

	it("deactivates an active account and removes it from listAccounts", async () => {
		const created = await upsertAccount(db, "test", {
			id: "ext-1",
			name: "Test Account",
			institution: "BankSA",
			type: "transaction",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const accountId = created.value.id;

		const beforeList = await listAccounts(db);
		expect(beforeList.ok).toBe(true);
		if (!beforeList.ok) return;
		expect(beforeList.value.some((a) => a.id === accountId)).toBe(true);

		const result = await deactivateAccount(db, accountId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.isActive).toBe(false);

		const afterList = await listAccounts(db);
		expect(afterList.ok).toBe(true);
		if (!afterList.ok) return;
		expect(afterList.value.some((a) => a.id === accountId)).toBe(false);
	});

	it("returns DB_ERROR for nonexistent account id", async () => {
		const result = await deactivateAccount(db, "nonexistent-id");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("DB_ERROR");
		expect(result.error.message).toContain("deactivate");
	});

	it("succeeds when deactivating an already-deactivated account", async () => {
		const created = await upsertAccount(db, "test", {
			id: "ext-1",
			name: "Test Account",
			institution: "BankSA",
			type: "transaction",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const accountId = created.value.id;

		const first = await deactivateAccount(db, accountId);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.isActive).toBe(false);

		const second = await deactivateAccount(db, accountId);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.isActive).toBe(false);
		expect(second.value.id).toBe(accountId);
	});
});

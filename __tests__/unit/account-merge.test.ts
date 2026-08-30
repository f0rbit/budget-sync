import { beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { type AppDatabase, createTestDb } from "../../src/db/client.js";
import { accounts, contributions, holdings, snapshots, transactions } from "../../src/db/schema.js";
import type { CategorizedTransaction } from "../../src/providers/types.js";
import { listAccounts, mergeAccounts, upsertAccount } from "../../src/services/account-service.js";
import { insertContributions } from "../../src/services/contribution-service.js";
import { upsertSnapshot } from "../../src/services/snapshot-service.js";
import { createTransaction } from "../../src/services/transaction-service.js";

function makeCategorizedTx(
	overrides: Partial<CategorizedTransaction> & { externalId: string },
): CategorizedTransaction {
	return {
		externalId: overrides.externalId,
		date: overrides.date ?? "2026-03-01",
		postDate: overrides.postDate ?? "2026-03-01",
		rawDescription: overrides.rawDescription ?? "TEST TRANSACTION",
		item: overrides.item ?? "Test Item",
		amount: overrides.amount ?? 10.0,
		direction: overrides.direction ?? "debit",
		category: overrides.category ?? "Other",
		notes: overrides.notes ?? "",
		excluded: overrides.excluded ?? false,
		accountId: overrides.accountId ?? "ext-1",
	};
}

describe("mergeAccounts", () => {
	let db: AppDatabase;
	let fromId: string;
	let intoId: string;

	beforeEach(async () => {
		db = createTestDb();
		const from = await upsertAccount(db, "csv", {
			id: "csv:Amplify",
			name: "Amplify Platinum",
			institution: "BankSA",
			type: "credit",
		});
		const into = await upsertAccount(db, "ai", {
			id: "ai:Amplify",
			name: "Amplify Platinum (dup)",
			institution: "BankSA",
			type: "credit",
		});
		expect(from.ok && into.ok).toBe(true);
		if (!from.ok || !into.ok) throw new Error("setup failed");
		fromId = from.value.id;
		intoId = into.value.id;
	});

	it("moves transactions, snapshots, holdings and contributions, then removes the from account", async () => {
		await createTransaction(db, fromId, makeCategorizedTx({ externalId: "tx-1", accountId: fromId }));
		await createTransaction(db, fromId, makeCategorizedTx({ externalId: "tx-2", accountId: fromId }));
		await upsertSnapshot(db, { accountId: fromId, date: "2026-03-01", balance: 500 });
		db.insert(holdings).values({ accountId: fromId, ticker: "VAS", units: 10, date: "2026-03-01" }).run();
		await insertContributions(db, fromId, [{ date: "2026-03-01", type: "employer", amount: 100 }]);

		const result = await mergeAccounts(db, fromId, intoId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.transactionsMoved).toBe(2);
		expect(result.value.snapshotsMoved).toBe(1);
		expect(result.value.holdingsMoved).toBe(1);
		expect(result.value.contributionsMoved).toBe(1);

		const remainingFrom = db.select().from(accounts).where(eq(accounts.id, fromId)).get();
		expect(remainingFrom).toBeUndefined();

		const movedTx = db.select().from(transactions).where(eq(transactions.accountId, intoId)).all();
		expect(movedTx.length).toBe(2);
		const movedSnap = db.select().from(snapshots).where(eq(snapshots.accountId, intoId)).all();
		expect(movedSnap.length).toBe(1);
		const movedHoldings = db.select().from(holdings).where(eq(holdings.accountId, intoId)).all();
		expect(movedHoldings.length).toBe(1);
		const movedContrib = db.select().from(contributions).where(eq(contributions.accountId, intoId)).all();
		expect(movedContrib.length).toBe(1);

		const all = await listAccounts(db);
		expect(all.ok).toBe(true);
		if (all.ok) expect(all.value.length).toBe(1);
	});

	it("dry-run reports counts without writing", async () => {
		await createTransaction(db, fromId, makeCategorizedTx({ externalId: "tx-1", accountId: fromId }));

		const result = await mergeAccounts(db, fromId, intoId, { dryRun: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.dryRun).toBe(true);
		expect(result.value.transactionsMoved).toBe(1);

		const remainingFrom = db.select().from(accounts).where(eq(accounts.id, fromId)).get();
		expect(remainingFrom).toBeDefined();
		const stillOnFrom = db.select().from(transactions).where(eq(transactions.accountId, fromId)).all();
		expect(stillOnFrom.length).toBe(1);
	});

	it("aborts with no partial writes on a transactions.external_id collision", async () => {
		// The app-level insert path already refuses a duplicate external_id (the
		// column is globally unique), so simulate a pre-existing corrupt/legacy
		// state by dropping the unique index just for this test's setup.
		db.run(sql`DROP INDEX transactions_external_id_idx`);
		await createTransaction(db, fromId, makeCategorizedTx({ externalId: "dup-id", accountId: fromId }));
		db.insert(transactions)
			.values({
				accountId: intoId,
				externalId: "dup-id",
				date: "2026-03-01",
				rawDescription: "dup",
				item: "dup",
				amount: 1,
				direction: "debit",
				category: "Other",
			})
			.run();
		await createTransaction(db, fromId, makeCategorizedTx({ externalId: "unique-id", accountId: fromId }));

		const result = await mergeAccounts(db, fromId, intoId);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("MERGE_CONFLICT");
		if (result.error.code !== "MERGE_CONFLICT") return;
		expect(result.error.collisions).toEqual([{ table: "transactions", externalId: "dup-id" }]);

		// no partial writes: both txs still on `from`, account still present
		const stillOnFrom = db.select().from(transactions).where(eq(transactions.accountId, fromId)).all();
		expect(stillOnFrom.length).toBe(2);
		const remainingFrom = db.select().from(accounts).where(eq(accounts.id, fromId)).get();
		expect(remainingFrom).toBeDefined();
	});

	it("aborts on a snapshots account+date collision", async () => {
		await upsertSnapshot(db, { accountId: fromId, date: "2026-03-01", balance: 500 });
		await upsertSnapshot(db, { accountId: intoId, date: "2026-03-01", balance: 600 });

		const result = await mergeAccounts(db, fromId, intoId);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("MERGE_CONFLICT");
		if (result.error.code !== "MERGE_CONFLICT") return;
		expect(result.error.collisions).toEqual([{ table: "snapshots", date: "2026-03-01" }]);
	});

	it("returns an error when either account does not exist", async () => {
		const result = await mergeAccounts(db, "nonexistent", intoId);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("DB_ERROR");
	});
});

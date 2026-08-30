import { type Result, ok, try_catch_async } from "@f0rbit/corpus";
import { and, eq, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { accounts, contributions, holdings, snapshots, transactions } from "../db/schema.js";
import { type DbError, type MergeCollision, errors } from "../errors.js";
import type { AccountInfo } from "../providers/types.js";

export type AccountRow = typeof accounts.$inferSelect;

/**
 * Find an active account by name, case-insensitive.
 * Name is the durable identity of an account across ingest runs — a person's
 * "Amplify Platinum" card doesn't change just because it was parsed by a
 * different provider/institution/type on a later run.
 */
export async function findAccountByName(db: AppDatabase, name: string): Promise<Result<AccountRow | null, DbError>> {
	return try_catch_async(
		async () => {
			const row = db
				.select()
				.from(accounts)
				.where(and(sql`lower(${accounts.name}) = lower(${name})`, eq(accounts.isActive, true)))
				.get();
			return row ?? null;
		},
		(e) => errors.dbError(`Failed to find account by name: ${e}`, e),
	);
}

/**
 * Upsert an account from provider data.
 * Matches on name (case-insensitive, active accounts only) so re-ingesting
 * the same account under a different provider/institution/type reuses the
 * existing row instead of spawning a duplicate. Falls back to matching on
 * (external_id, provider) for accounts not yet resolvable by name.
 */
export async function upsertAccount(
	db: AppDatabase,
	providerName: string,
	info: AccountInfo,
): Promise<Result<AccountRow, DbError>> {
	return try_catch_async(
		async () => {
			const existing =
				db
					.select()
					.from(accounts)
					.where(and(sql`lower(${accounts.name}) = lower(${info.name})`, eq(accounts.isActive, true)))
					.get() ??
				db
					.select()
					.from(accounts)
					.where(and(eq(accounts.externalId, info.id), eq(accounts.provider, providerName)))
					.get();

			if (existing) {
				const updated = db
					.update(accounts)
					.set({
						externalId: info.id,
						provider: providerName,
						name: info.name,
						institution: info.institution,
						type: info.type,
						updatedAt: new Date(),
					})
					.where(eq(accounts.id, existing.id))
					.returning()
					.get();
				return updated;
			}

			const created = db
				.insert(accounts)
				.values({
					externalId: info.id,
					provider: providerName,
					name: info.name,
					institution: info.institution,
					type: info.type,
				})
				.returning()
				.get();
			return created;
		},
		(e) => errors.dbError(`Failed to upsert account: ${e}`, e),
	);
}

/**
 * List all active accounts.
 */
export async function listAccounts(db: AppDatabase): Promise<Result<AccountRow[], DbError>> {
	return try_catch_async(
		async () => {
			return db.select().from(accounts).where(eq(accounts.isActive, true)).all();
		},
		(e) => errors.dbError(`Failed to list accounts: ${e}`, e),
	);
}

/**
 * Deactivate an account (soft-delete).
 */
export async function deactivateAccount(db: AppDatabase, accountId: string): Promise<Result<AccountRow, DbError>> {
	return try_catch_async(
		async () => {
			const updated = db
				.update(accounts)
				.set({ isActive: false, updatedAt: new Date() })
				.where(eq(accounts.id, accountId))
				.returning()
				.get();

			if (!updated) {
				throw new Error(`Account not found: ${accountId}`);
			}

			return updated;
		},
		(e) => errors.dbError(`Failed to deactivate account: ${e}`, e),
	);
}

export interface MergeAccountsResult {
	fromAccountId: string;
	intoAccountId: string;
	transactionsMoved: number;
	snapshotsMoved: number;
	holdingsMoved: number;
	contributionsMoved: number;
	dryRun: boolean;
}

class MergeConflictSignal extends Error {
	constructor(readonly collisions: MergeCollision[]) {
		super("Merge would violate a unique constraint");
	}
}

/**
 * Merge one account into another: reassigns every row referencing `fromAccountId`
 * (transactions, snapshots, holdings, contributions) to `intoAccountId`, then
 * removes the now-empty `from` account. Runs inside one DB transaction, so a
 * unique-constraint collision (duplicate transaction external_id, or a
 * snapshot already present for the same account+date) aborts with no partial
 * writes. Pass `dryRun: true` to preview the move without writing.
 */
export async function mergeAccounts(
	db: AppDatabase,
	fromAccountId: string,
	intoAccountId: string,
	options?: { dryRun?: boolean },
): Promise<Result<MergeAccountsResult, DbError>> {
	return try_catch_async(
		async () => {
			if (fromAccountId === intoAccountId) {
				throw new Error("Cannot merge an account into itself");
			}

			const fromAccount = db.select().from(accounts).where(eq(accounts.id, fromAccountId)).get();
			if (!fromAccount) throw new Error(`Account not found: ${fromAccountId}`);

			const intoAccount = db.select().from(accounts).where(eq(accounts.id, intoAccountId)).get();
			if (!intoAccount) throw new Error(`Account not found: ${intoAccountId}`);

			const movingTx = db.select().from(transactions).where(eq(transactions.accountId, fromAccountId)).all();
			const otherExternalIds = new Set(
				db
					.select({ externalId: transactions.externalId })
					.from(transactions)
					.where(ne(transactions.accountId, fromAccountId))
					.all()
					.flatMap((r) => (r.externalId ? [r.externalId] : [])),
			);
			const txCollisions: MergeCollision[] = movingTx
				.filter((t) => t.externalId !== null && otherExternalIds.has(t.externalId))
				.map((t) => ({ table: "transactions" as const, externalId: t.externalId as string }));

			const movingSnaps = db.select().from(snapshots).where(eq(snapshots.accountId, fromAccountId)).all();
			const intoSnapDates = new Set(
				db
					.select({ date: snapshots.date })
					.from(snapshots)
					.where(eq(snapshots.accountId, intoAccountId))
					.all()
					.map((r) => r.date),
			);
			const snapCollisions: MergeCollision[] = movingSnaps
				.filter((s) => intoSnapDates.has(s.date))
				.map((s) => ({ table: "snapshots" as const, date: s.date }));

			const collisions = [...txCollisions, ...snapCollisions];
			if (collisions.length > 0) {
				throw new MergeConflictSignal(collisions);
			}

			const movingHoldings = db.select().from(holdings).where(eq(holdings.accountId, fromAccountId)).all();
			const movingContributions = db
				.select()
				.from(contributions)
				.where(eq(contributions.accountId, fromAccountId))
				.all();

			if (options?.dryRun) {
				return {
					fromAccountId,
					intoAccountId,
					transactionsMoved: movingTx.length,
					snapshotsMoved: movingSnaps.length,
					holdingsMoved: movingHoldings.length,
					contributionsMoved: movingContributions.length,
					dryRun: true,
				};
			}

			return db.transaction((tx) => {
				tx.update(transactions)
					.set({ accountId: intoAccountId })
					.where(eq(transactions.accountId, fromAccountId))
					.run();
				tx.update(snapshots).set({ accountId: intoAccountId }).where(eq(snapshots.accountId, fromAccountId)).run();
				tx.update(holdings).set({ accountId: intoAccountId }).where(eq(holdings.accountId, fromAccountId)).run();
				tx.update(contributions)
					.set({ accountId: intoAccountId })
					.where(eq(contributions.accountId, fromAccountId))
					.run();
				tx.delete(accounts).where(eq(accounts.id, fromAccountId)).run();

				return {
					fromAccountId,
					intoAccountId,
					transactionsMoved: movingTx.length,
					snapshotsMoved: movingSnaps.length,
					holdingsMoved: movingHoldings.length,
					contributionsMoved: movingContributions.length,
					dryRun: false,
				};
			});
		},
		(e) => {
			if (e instanceof MergeConflictSignal) {
				return errors.mergeConflict(
					e.collisions,
					`Merge would violate unique constraints: ${e.collisions.length} collision(s)`,
				);
			}
			return errors.dbError(`Failed to merge accounts: ${e}`, e);
		},
	);
}

/**
 * Find an account's internal ID by its external provider ID.
 * Used during sync to map provider account IDs to DB account IDs.
 */
export async function findAccountByExternalId(
	db: AppDatabase,
	providerName: string,
	externalId: string,
): Promise<Result<AccountRow | null, DbError>> {
	return try_catch_async(
		async () => {
			const row = db
				.select()
				.from(accounts)
				.where(and(eq(accounts.externalId, externalId), eq(accounts.provider, providerName)))
				.get();
			return row ?? null;
		},
		(e) => errors.dbError(`Failed to find account: ${e}`, e),
	);
}

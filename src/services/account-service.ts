import { type Result, ok, try_catch_async } from "@f0rbit/corpus";
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { accounts } from "../db/schema.js";
import { type DbError, errors } from "../errors.js";
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

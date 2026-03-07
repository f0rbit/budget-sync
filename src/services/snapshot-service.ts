import { type Result, ok, try_catch_async } from "@f0rbit/corpus";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { accounts, snapshots } from "../db/schema.js";
import { type DbError, errors } from "../errors.js";
import type { AccountType } from "../providers/types.js";

export type SnapshotRow = typeof snapshots.$inferSelect;

export interface SnapshotFilters {
	accountId?: string;
	dateFrom?: string; // YYYY-MM-DD
	dateTo?: string; // YYYY-MM-DD
}

export interface EnrichedSnapshot extends SnapshotRow {
	accountName: string;
	accountType: AccountType;
}

/**
 * Insert or update a snapshot for a given account+date.
 */
export async function upsertSnapshot(
	db: AppDatabase,
	data: {
		accountId: string;
		date: string;
		balance: number;
		available?: number;
		syncRunId?: string;
	},
): Promise<Result<SnapshotRow, DbError>> {
	return try_catch_async(
		async () => {
			const row = db
				.insert(snapshots)
				.values({
					accountId: data.accountId,
					date: data.date,
					balance: data.balance,
					available: data.available,
					syncRunId: data.syncRunId,
				})
				.onConflictDoUpdate({
					target: [snapshots.accountId, snapshots.date],
					set: {
						balance: data.balance,
						available: data.available,
						syncRunId: data.syncRunId,
						createdAt: new Date(),
					},
				})
				.returning()
				.get();
			return row;
		},
		(e) => errors.dbError(`Failed to upsert snapshot: ${e}`, e),
	);
}

/**
 * Get the latest snapshot for each active account.
 */
export async function getLatestSnapshots(db: AppDatabase): Promise<Result<EnrichedSnapshot[], DbError>> {
	return try_catch_async(
		async () => {
			const rows = db
				.select({
					id: snapshots.id,
					accountId: snapshots.accountId,
					date: snapshots.date,
					balance: snapshots.balance,
					available: snapshots.available,
					syncRunId: snapshots.syncRunId,
					createdAt: snapshots.createdAt,
					accountName: accounts.name,
					accountType: accounts.type,
				})
				.from(snapshots)
				.innerJoin(accounts, eq(snapshots.accountId, accounts.id))
				.where(
					and(
						eq(accounts.isActive, true),
						eq(
							snapshots.date,
							sql`(SELECT MAX(s2.date) FROM snapshots s2 WHERE s2.account_id = ${snapshots.accountId})`,
						),
					),
				)
				.all();

			return rows as EnrichedSnapshot[];
		},
		(e) => errors.dbError(`Failed to get latest snapshots: ${e}`, e),
	);
}

/**
 * Get snapshot history with optional filters.
 */
export async function getSnapshotHistory(
	db: AppDatabase,
	filters?: SnapshotFilters,
): Promise<Result<EnrichedSnapshot[], DbError>> {
	return try_catch_async(
		async () => {
			const conditions = [];

			if (filters?.accountId) {
				conditions.push(eq(snapshots.accountId, filters.accountId));
			}
			if (filters?.dateFrom) {
				conditions.push(gte(snapshots.date, filters.dateFrom));
			}
			if (filters?.dateTo) {
				conditions.push(lte(snapshots.date, filters.dateTo));
			}

			const rows = db
				.select({
					id: snapshots.id,
					accountId: snapshots.accountId,
					date: snapshots.date,
					balance: snapshots.balance,
					available: snapshots.available,
					syncRunId: snapshots.syncRunId,
					createdAt: snapshots.createdAt,
					accountName: accounts.name,
					accountType: accounts.type,
				})
				.from(snapshots)
				.innerJoin(accounts, eq(snapshots.accountId, accounts.id))
				.where(conditions.length > 0 ? and(...conditions) : undefined)
				.orderBy(desc(snapshots.date))
				.all();

			return rows as EnrichedSnapshot[];
		},
		(e) => errors.dbError(`Failed to get snapshot history: ${e}`, e),
	);
}

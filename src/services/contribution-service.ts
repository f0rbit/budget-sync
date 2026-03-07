import { type Result, try_catch_async } from "@f0rbit/corpus";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { contributions } from "../db/schema.js";
import { type DbError, errors } from "../errors.js";
import type { ContributionType } from "../providers/types.js";

export type ContributionRow = typeof contributions.$inferSelect;

export interface ContributionFilters {
	accountId?: string;
	dateFrom?: string;
	dateTo?: string;
	type?: ContributionType;
}

interface ContributionItem {
	date: string;
	type: ContributionType;
	amount: number;
	description?: string;
	syncRunId?: string;
}

function buildConditions(filters?: ContributionFilters) {
	const conditions = [];
	if (filters?.accountId) {
		conditions.push(eq(contributions.accountId, filters.accountId));
	}
	if (filters?.dateFrom) {
		conditions.push(gte(contributions.date, filters.dateFrom));
	}
	if (filters?.dateTo) {
		conditions.push(lte(contributions.date, filters.dateTo));
	}
	if (filters?.type) {
		conditions.push(eq(contributions.type, filters.type));
	}
	return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Batch insert contributions with check-before-insert dedup.
 * Two identical contributions can legitimately exist, so we use a soft check
 * on (accountId, date, type, amount) rather than a unique constraint.
 */
export async function insertContributions(
	db: AppDatabase,
	accountId: string,
	items: ContributionItem[],
): Promise<Result<{ inserted: number; skipped: number }, DbError>> {
	return try_catch_async(
		async () => {
			let inserted = 0;
			let skipped = 0;

			for (const item of items) {
				const existing = db
					.select({ id: contributions.id })
					.from(contributions)
					.where(
						and(
							eq(contributions.accountId, accountId),
							eq(contributions.date, item.date),
							eq(contributions.type, item.type),
							eq(contributions.amount, item.amount),
						),
					)
					.get();

				if (existing) {
					skipped++;
					continue;
				}

				db.insert(contributions)
					.values({
						accountId,
						date: item.date,
						type: item.type,
						amount: item.amount,
						description: item.description,
						syncRunId: item.syncRunId,
					})
					.run();

				inserted++;
			}

			return { inserted, skipped };
		},
		(e) => errors.dbError(`Failed to insert contributions: ${e}`, e),
	);
}

/**
 * Query contributions with optional filters. Ordered by date descending.
 */
export async function getContributions(
	db: AppDatabase,
	filters?: ContributionFilters,
): Promise<Result<ContributionRow[], DbError>> {
	return try_catch_async(
		async () => {
			return db.select().from(contributions).where(buildConditions(filters)).orderBy(desc(contributions.date)).all();
		},
		(e) => errors.dbError(`Failed to get contributions: ${e}`, e),
	);
}

/**
 * Aggregate contribution totals grouped by type.
 */
export async function getContributionSummary(
	db: AppDatabase,
	filters?: ContributionFilters,
): Promise<Result<{ type: ContributionType; total: number; count: number }[], DbError>> {
	return try_catch_async(
		async () => {
			const rows = db
				.select({
					type: contributions.type,
					total: sql<number>`SUM(${contributions.amount})`,
					count: sql<number>`COUNT(*)`,
				})
				.from(contributions)
				.where(buildConditions(filters))
				.groupBy(contributions.type)
				.all();

			return rows as { type: ContributionType; total: number; count: number }[];
		},
		(e) => errors.dbError(`Failed to get contribution summary: ${e}`, e),
	);
}

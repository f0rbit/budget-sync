import { type Result, try_catch_async } from "@f0rbit/corpus";
import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { accounts, transactions } from "../db/schema.js";
import { type DbError, errors } from "../errors.js";
import type { AccountType, CategorizedTransaction, Category } from "../providers/types.js";

// === Types ===

export interface TransactionFilters {
	dateFrom?: string; // YYYY-MM-DD
	dateTo?: string; // YYYY-MM-DD
	category?: Category;
	accountId?: string;
	limit?: number;
}

export type TransactionRow = typeof transactions.$inferSelect;

// === Functions ===

export async function createTransaction(
	db: AppDatabase,
	accountId: string,
	data: CategorizedTransaction,
	syncRunId?: string,
): Promise<Result<TransactionRow, DbError>> {
	return try_catch_async(
		async () => {
			if (data.externalId) {
				const existing = db.select().from(transactions).where(eq(transactions.externalId, data.externalId)).get();

				if (existing) {
					throw { __duplicate: true, externalId: data.externalId };
				}
			}

			const row = db
				.insert(transactions)
				.values({
					accountId,
					externalId: data.externalId,
					date: data.date,
					postDate: data.postDate,
					rawDescription: data.rawDescription,
					item: data.item,
					amount: data.amount,
					direction: data.direction,
					category: data.category,
					notes: data.notes,
					excluded: data.excluded,
					excludeReason: data.excludeReason ?? null,
					syncRunId: syncRunId ?? null,
				})
				.returning()
				.get();

			return row;
		},
		(e) => {
			if (e && typeof e === "object" && "__duplicate" in e) {
				return errors.duplicate(
					(e as unknown as { externalId: string }).externalId,
					"Transaction with external_id already exists",
				);
			}
			return errors.dbError(`Failed to create transaction: ${e}`, e);
		},
	);
}

export async function getTransactions(
	db: AppDatabase,
	filters?: TransactionFilters,
): Promise<Result<TransactionRow[], DbError>> {
	return try_catch_async(
		async () => {
			const conditions = [];

			if (filters?.dateFrom) {
				conditions.push(gte(transactions.date, filters.dateFrom));
			}
			if (filters?.dateTo) {
				conditions.push(lte(transactions.date, filters.dateTo));
			}
			if (filters?.category) {
				conditions.push(eq(transactions.category, filters.category));
			}
			if (filters?.accountId) {
				conditions.push(eq(transactions.accountId, filters.accountId));
			}

			let query = db.select().from(transactions).orderBy(desc(transactions.date));

			if (conditions.length > 0) {
				query = query.where(and(...conditions)) as typeof query;
			}

			if (filters?.limit) {
				query = query.limit(filters.limit) as typeof query;
			}

			return query.all();
		},
		(e) => errors.dbError(`Failed to query transactions: ${e}`, e),
	);
}

export async function getUncategorized(db: AppDatabase): Promise<Result<TransactionRow[], DbError>> {
	return getTransactions(db, { category: "Other" });
}

export async function searchTransactions(
	db: AppDatabase,
	query: string,
	limit?: number,
): Promise<Result<TransactionRow[], DbError>> {
	return try_catch_async(
		async () => {
			const pattern = `%${query}%`;
			return db
				.select()
				.from(transactions)
				.where(or(like(transactions.item, pattern), like(transactions.rawDescription, pattern)))
				.orderBy(desc(transactions.date))
				.limit(limit ?? 50)
				.all();
		},
		(e) => errors.dbError(`Failed to search transactions: ${e}`, e),
	);
}

export async function getCategorySummary(
	db: AppDatabase,
	filters?: { dateFrom?: string; dateTo?: string; accountId?: string },
): Promise<Result<Array<{ category: string; total: number; count: number }>, DbError>> {
	return try_catch_async(
		async () => {
			const conditions = [];
			if (filters?.dateFrom) conditions.push(gte(transactions.date, filters.dateFrom));
			if (filters?.dateTo) conditions.push(lte(transactions.date, filters.dateTo));
			if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId));

			const baseQuery =
				conditions.length > 0
					? db
							.select({
								category: transactions.category,
								total: sql<number>`sum(${transactions.amount})`,
								count: sql<number>`count(*)`,
							})
							.from(transactions)
							.where(and(...conditions))
							.groupBy(transactions.category)
							.orderBy(desc(sql`sum(${transactions.amount})`))
					: db
							.select({
								category: transactions.category,
								total: sql<number>`sum(${transactions.amount})`,
								count: sql<number>`count(*)`,
							})
							.from(transactions)
							.groupBy(transactions.category)
							.orderBy(desc(sql`sum(${transactions.amount})`));

			return baseQuery.all();
		},
		(e) => errors.dbError(`Failed to get category summary: ${e}`, e),
	);
}

// === Dedup helpers ===

export interface DedupCandidate {
	id: string;
	accountId: string;
	accountType: AccountType;
	date: string;
	item: string;
	amount: number;
	excluded: boolean;
}

export async function getExistingDebitsForDedup(
	db: AppDatabase,
	dateFrom: string,
	dateTo: string,
): Promise<Result<DedupCandidate[], DbError>> {
	return try_catch_async(
		async () => {
			const rows = db
				.select({
					id: transactions.id,
					accountId: accounts.externalId,
					accountType: accounts.type,
					date: transactions.date,
					item: transactions.item,
					amount: transactions.amount,
					excluded: transactions.excluded,
				})
				.from(transactions)
				.innerJoin(accounts, eq(transactions.accountId, accounts.id))
				.where(
					and(
						eq(transactions.direction, "debit"),
						eq(transactions.excluded, false),
						gte(transactions.date, dateFrom),
						lte(transactions.date, dateTo),
					),
				)
				.all();

			return rows as DedupCandidate[];
		},
		(e) => errors.dbError(`Failed to query transactions for dedup: ${e}`, e),
	);
}

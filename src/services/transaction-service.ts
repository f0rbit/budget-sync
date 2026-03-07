import { type Result, try_catch_async } from "@f0rbit/corpus";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { transactions } from "../db/schema.js";
import { type DbError, errors } from "../errors.js";
import type { CategorizedTransaction, Category } from "../providers/types.js";

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

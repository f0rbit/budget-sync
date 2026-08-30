import { type Result, ok, try_catch_async } from "@f0rbit/corpus";
import { and, desc, eq, gte, inArray, like, lte, or } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { accounts, transactions } from "../db/schema.js";
import { type DbError, errors } from "../errors.js";
import { UNMAPPED_CREDIT_NOTE } from "../providers/types.js";
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

/**
 * A row "needs mapping" if it landed in the debit fallback ("Other") or the
 * credit fallback (flagged with UNMAPPED_CREDIT_NOTE). Single predicate used
 * by both `mappings unmapped` and `mappings apply`.
 */
export function isUnmappedRow(row: Pick<TransactionRow, "category" | "notes">): boolean {
	return row.category === "Other" || row.notes === UNMAPPED_CREDIT_NOTE;
}

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
	const result = await getTransactions(db);
	if (!result.ok) return result;
	return ok(result.value.filter((row) => !row.excluded && isUnmappedRow(row)));
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

export interface ReportRowFilters {
	dateFrom?: string;
	dateTo?: string;
	accountId?: string;
}

/**
 * Non-excluded rows for the pure report layer (src/reporting/), ascending by
 * date. The one DB query every report function is fed from.
 */
export async function getReportRows(
	db: AppDatabase,
	filters?: ReportRowFilters,
): Promise<Result<TransactionRow[], DbError>> {
	return try_catch_async(
		async () => {
			const conditions = [eq(transactions.excluded, false)];
			if (filters?.dateFrom) conditions.push(gte(transactions.date, filters.dateFrom));
			if (filters?.dateTo) conditions.push(lte(transactions.date, filters.dateTo));
			if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId));

			return db
				.select()
				.from(transactions)
				.where(and(...conditions))
				.orderBy(transactions.date)
				.all();
		},
		(e) => errors.dbError(`Failed to get report rows: ${e}`, e),
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

// === Manual edit ("transactions set") helpers ===

export type TransactionSelector = { ids: string[] } | { match?: string; dateFrom?: string; dateTo?: string };

export interface TransactionUpdate {
	category?: Category;
	item?: string;
	notes?: string;
}

export async function selectTransactions(
	db: AppDatabase,
	selector: TransactionSelector,
): Promise<Result<TransactionRow[], DbError>> {
	return try_catch_async(
		async () => {
			if ("ids" in selector) {
				if (selector.ids.length === 0) return [];
				return db.select().from(transactions).where(inArray(transactions.id, selector.ids)).all();
			}

			const conditions = [];
			if (selector.match) {
				conditions.push(like(transactions.rawDescription, `%${selector.match}%`));
			}
			if (selector.dateFrom) conditions.push(gte(transactions.date, selector.dateFrom));
			if (selector.dateTo) conditions.push(lte(transactions.date, selector.dateTo));

			let query = db.select().from(transactions).orderBy(desc(transactions.date));
			if (conditions.length > 0) {
				query = query.where(and(...conditions)) as typeof query;
			}
			return query.all();
		},
		(e) => errors.dbError(`Failed to select transactions: ${e}`, e),
	);
}

export async function updateTransactions(
	db: AppDatabase,
	ids: string[],
	update: TransactionUpdate,
): Promise<Result<TransactionRow[], DbError>> {
	return try_catch_async(
		async () => {
			const set: Partial<typeof transactions.$inferInsert> = {};
			if (update.category !== undefined) set.category = update.category;
			if (update.item !== undefined) set.item = update.item;
			if (update.notes !== undefined) set.notes = update.notes;

			const updated: TransactionRow[] = [];
			for (const id of ids) {
				const row = db.update(transactions).set(set).where(eq(transactions.id, id)).returning().get();
				if (row) updated.push(row);
			}
			return updated;
		},
		(e) => errors.dbError(`Failed to update transactions: ${e}`, e),
	);
}

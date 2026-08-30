import { type Result, try_catch_async } from "@f0rbit/corpus";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { transactions } from "../db/schema.js";
import { type DbError, errors } from "../errors.js";
import { matchExclusionRule } from "../pipeline/filter.js";
import { matchTransaction, resolveMappedCategory } from "../pipeline/local-mappings.js";
import { UNMAPPED_CREDIT_NOTE } from "../providers/types.js";
import type { Category, ExclusionRule, MerchantMapping } from "../providers/types.js";
import { isUnmappedRow } from "./transaction-service.js";

export type TransactionRow = typeof transactions.$inferSelect;

export interface ApplyMappingsOptions {
	/** Recategorize even if the row doesn't need mapping (isUnmappedRow) */
	force?: boolean;
}

export type MappingApplyChange =
	| { type: "excluded"; row: TransactionRow; reason: string }
	| { type: "recategorized"; row: TransactionRow; item: string; category: Category; clearNote: boolean };

export interface MappingApplyPlan {
	scanned: number;
	changes: MappingApplyChange[];
}

/**
 * Pure planning step: decides what would change for each existing row, without touching the DB.
 * Exclusion rules take priority over mapping recategorization.
 */
export function planMappingsApply(
	rows: TransactionRow[],
	mappings: MerchantMapping[],
	exclusions: ExclusionRule[],
	options?: ApplyMappingsOptions,
): MappingApplyPlan {
	const changes: MappingApplyChange[] = [];

	for (const row of rows) {
		if (!row.excluded) {
			const rule = matchExclusionRule(row.rawDescription, exclusions);
			if (rule) {
				changes.push({ type: "excluded", row, reason: rule.reason });
				continue;
			}
		}

		if (row.excluded) continue;
		if (!isUnmappedRow(row) && !options?.force) continue;

		const mapping = matchTransaction(row.rawDescription, mappings);
		if (!mapping) continue;

		const category = resolveMappedCategory(row.direction, mapping.category);
		const clearNote = row.notes === UNMAPPED_CREDIT_NOTE;
		if (mapping.item === row.item && category === row.category && !clearNote) continue;

		changes.push({ type: "recategorized", row, item: mapping.item, category, clearNote });
	}

	return { scanned: rows.length, changes };
}

/** Applies a plan's changes to the database. Call with a plan from a prior planMappingsApply(). */
export async function applyMappingsPlan(
	db: AppDatabase,
	plan: MappingApplyPlan,
): Promise<Result<MappingApplyPlan, DbError>> {
	return try_catch_async(
		async () => {
			for (const change of plan.changes) {
				if (change.type === "excluded") {
					db.update(transactions)
						.set({ excluded: true, excludeReason: change.reason })
						.where(eq(transactions.id, change.row.id))
						.run();
				} else {
					db.update(transactions)
						.set({
							item: change.item,
							category: change.category,
							...(change.clearNote ? { notes: "" } : {}),
						})
						.where(eq(transactions.id, change.row.id))
						.run();
				}
			}
			return plan;
		},
		(e) => errors.dbError(`Failed to apply mappings: ${e}`, e),
	);
}

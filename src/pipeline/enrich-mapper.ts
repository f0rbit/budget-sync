import type { CategorizedTransaction, RawTransaction } from "../providers/types.js";

/**
 * Create a fallback categorized transaction when no mapping matches.
 * Category defaults to "Other".
 */
export function createFallback(tx: RawTransaction): CategorizedTransaction {
	return {
		externalId: tx.id,
		date: tx.transactionDate,
		postDate: tx.postDate,
		rawDescription: tx.description,
		item: tx.description,
		amount: tx.amount,
		direction: tx.direction,
		category: "Other",
		notes: "",
		excluded: false,
		accountId: tx.accountId,
	};
}

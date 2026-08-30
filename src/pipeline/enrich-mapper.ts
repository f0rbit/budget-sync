import { UNMAPPED_CREDIT_NOTE } from "../providers/types.js";
import type { CategorizedTransaction, RawTransaction } from "../providers/types.js";

/**
 * Create a fallback categorized transaction when no mapping matches.
 * Debits default to "Other"; unmapped credits default to "Income" (flagged
 * for review) since salary-sized unknown credits are far more likely income
 * than a refund.
 */
export function createFallback(tx: RawTransaction): CategorizedTransaction {
	const isCredit = tx.direction === "credit";

	return {
		externalId: tx.id,
		date: tx.transactionDate,
		postDate: tx.postDate,
		rawDescription: tx.description,
		item: tx.description,
		amount: tx.amount,
		direction: tx.direction,
		category: isCredit ? "Income" : "Other",
		notes: isCredit ? UNMAPPED_CREDIT_NOTE : "",
		excluded: false,
		accountId: tx.accountId,
	};
}

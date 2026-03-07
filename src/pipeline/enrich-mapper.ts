import type { CategorizedTransaction, Category, EnrichmentData, RawTransaction } from "../providers/types.js";

/**
 * Static mapping from Basiq enrichment category names to local categories.
 * Basiq categories come from their enrichment API and don't match ours 1:1.
 *
 * Any Basiq category not in this map falls through to "Other".
 */
const ENRICHMENT_CATEGORY_MAP: Record<string, Category> = {
	"Food & Dining": "Eating Out",
	Restaurants: "Eating Out",
	"Fast Food": "Eating Out",
	"Coffee Shops": "Eating Out",
	Groceries: "Woolworths", // May be wrong for non-Woolworths groceries, but best guess
	Supermarkets: "Woolworths",
	"Alcohol & Bars": "Alcohol",
	Bars: "Alcohol",
	Transportation: "Transport",
	"Public Transportation": "Transport",
	"Ride Sharing": "Transport",
	Taxi: "Transport",
	"Bills & Utilities": "Bills",
	Internet: "Bills",
	Phone: "Bills",
	Utilities: "Bills",
	"Health & Fitness": "Health",
	Pharmacy: "Health",
	Doctor: "Health",
	"Health Insurance": "Health",
	Entertainment: "Entertainment",
	"Movies & DVDs": "Entertainment",
	Music: "Entertainment",
	Arts: "Entertainment",
	Shopping: "Shopping",
	Clothing: "Shopping",
	"Electronics & Software": "Shopping",
	Home: "Shopping",
	Subscription: "Subscriptions",
	Subscriptions: "Subscriptions",
	"Streaming Services": "Subscriptions",
	Rent: "Rent", // Shouldn't reach here if rent handler caught it, but just in case
};

/**
 * Map enrichment data to a local category.
 * Returns the mapped category or null if no mapping exists.
 */
export function mapEnrichmentCategory(enrichment: EnrichmentData): Category | null {
	if (!enrichment.category) return null;

	const mapped = ENRICHMENT_CATEGORY_MAP[enrichment.category];
	if (mapped) return mapped;

	// Try case-insensitive match
	const lower = enrichment.category.toLowerCase();
	for (const [key, value] of Object.entries(ENRICHMENT_CATEGORY_MAP)) {
		if (key.toLowerCase() === lower) return value;
	}

	return null;
}

/**
 * Apply enrichment data to a raw transaction, producing a categorized transaction.
 * Uses the enrichment merchant name as the item if available, otherwise
 * falls back to the raw description.
 */
export function applyEnrichment(
	tx: RawTransaction,
	enrichment: EnrichmentData,
	category: Category,
): CategorizedTransaction {
	return {
		externalId: tx.id,
		date: tx.transactionDate,
		postDate: tx.postDate,
		rawDescription: tx.description,
		item: enrichment.merchantName ?? tx.description,
		amount: tx.amount,
		direction: tx.direction,
		category,
		notes: enrichment.location ? `Location: ${enrichment.location}` : "",
		excluded: false,
		accountId: tx.accountId,
	};
}

/**
 * Create a fallback categorized transaction when no mapping or enrichment matches.
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

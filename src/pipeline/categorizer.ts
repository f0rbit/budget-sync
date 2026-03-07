import type { RentConfig } from "../config.js";
import {
	type AiCategorizationRequest,
	type AiCategorizationResult,
	type AiCategorizer,
	CATEGORY_DESCRIPTIONS,
	type CategorizedTransaction,
	type Category,
	type ExcludedTransaction,
	type MerchantMappings,
	type RawTransaction,
} from "../providers/types.js";
import { createFallback } from "./enrich-mapper.js";
import { filterTransaction } from "./filter.js";
import { applyMapping, matchTransaction } from "./local-mappings.js";
import { handleRent, isRentTransaction } from "./rent.js";

export interface PipelineContext {
	mappings: MerchantMappings;
	rentConfig: RentConfig;
	aiCategorizer?: AiCategorizer;
}

export type PipelineOutput =
	| { type: "categorized"; transaction: CategorizedTransaction }
	| { type: "excluded"; transaction: ExcludedTransaction };

export async function categorizePipeline(tx: RawTransaction, context: PipelineContext): Promise<PipelineOutput> {
	// Step 1: Filter — exclude credits and pattern-matched exclusions
	const filterResult = filterTransaction(tx, context.mappings.exclusions);
	if (!filterResult.ok) {
		return { type: "excluded", transaction: filterResult.error };
	}
	const passedTx = filterResult.value;

	// Step 2: Rent — short-circuit if rent payment
	if (isRentTransaction(passedTx, context.rentConfig)) {
		return { type: "categorized", transaction: handleRent(passedTx, context.rentConfig) };
	}

	// Step 3: Local mapping — match against merchant-mappings.jsonc rules
	const mapping = matchTransaction(passedTx.description, context.mappings.mappings);
	if (mapping) {
		return { type: "categorized", transaction: applyMapping(passedTx, mapping) };
	}

	// Step 4: Fallback — categorize as "Other"
	return { type: "categorized", transaction: createFallback(passedTx) };
}

export async function categorizeAll(
	transactions: RawTransaction[],
	context: PipelineContext,
): Promise<{
	categorized: CategorizedTransaction[];
	excluded: ExcludedTransaction[];
	aiCategorizationResult?: AiCategorizationResult;
}> {
	const categorized: CategorizedTransaction[] = [];
	const excluded: ExcludedTransaction[] = [];

	// Steps 1-4: Per-transaction pipeline (filter → rent → mapping → fallback)
	for (const tx of transactions) {
		const result = await categorizePipeline(tx, context);
		if (result.type === "categorized") {
			categorized.push(result.transaction);
		} else {
			excluded.push(result.transaction);
		}
	}

	// Step 5: AI batch categorization for "Other" transactions
	if (context.aiCategorizer) {
		const uncategorized = categorized.filter((tx) => tx.category === "Other");
		if (uncategorized.length > 0) {
			const alreadyCategorized = categorized.filter((tx) => tx.category !== "Other");

			const request: AiCategorizationRequest = {
				uncategorized: uncategorized.map((tx) => ({
					externalId: tx.externalId,
					description: tx.rawDescription,
					amount: tx.amount,
					date: tx.date,
				})),
				context: {
					categorizedTransactions: alreadyCategorized.slice(0, 10).map((tx) => ({
						item: tx.item,
						category: tx.category,
						amount: tx.amount,
						date: tx.date,
					})),
					categories: (Object.entries(CATEGORY_DESCRIPTIONS) as [Category, string][]).map(([name, description]) => ({
						name,
						description,
					})),
					existingMappings: context.mappings.mappings,
				},
			};

			const aiResult = await context.aiCategorizer.categorize(request);
			if (aiResult.ok) {
				// Apply AI categorizations to the "Other" transactions
				for (const cat of aiResult.value.categorizations) {
					const tx = categorized.find((t) => t.externalId === cat.externalId);
					if (tx) {
						tx.category = cat.category;
						tx.item = cat.item;
						if (cat.notes) tx.notes = cat.notes;
					}
				}
				return { categorized, excluded, aiCategorizationResult: aiResult.value };
			}
			// AI failure is non-fatal — transactions stay as "Other"
		}
	}

	return { categorized, excluded };
}

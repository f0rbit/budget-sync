import type { Result } from "@f0rbit/corpus";
import type { RentConfig } from "../config.js";
import type {
	CategorizedTransaction,
	EnrichmentData,
	ExcludedTransaction,
	MerchantMappings,
	RawTransaction,
} from "../providers/types.js";
import { applyEnrichment, createFallback, mapEnrichmentCategory } from "./enrich-mapper.js";
import { filterTransaction } from "./filter.js";
import { applyMapping, matchTransaction } from "./local-mappings.js";
import { handleRent, isRentTransaction } from "./rent.js";

export interface PipelineContext {
	mappings: MerchantMappings;
	rentConfig: RentConfig;
	enrichTransaction?: (description: string) => Promise<Result<EnrichmentData, unknown>>;
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

	// Step 4a: Inline enrichment — use data already attached to the transaction
	if (passedTx.enrichment) {
		const category = mapEnrichmentCategory(passedTx.enrichment);
		if (category) {
			return { type: "categorized", transaction: applyEnrichment(passedTx, passedTx.enrichment, category) };
		}
	}

	// Step 4b: API enrichment — call provider if available (non-fatal on failure)
	if (context.enrichTransaction) {
		const enrichResult = await context.enrichTransaction(passedTx.description);
		if (enrichResult.ok) {
			const category = mapEnrichmentCategory(enrichResult.value);
			if (category) {
				return { type: "categorized", transaction: applyEnrichment(passedTx, enrichResult.value, category) };
			}
		}
	}

	// Step 5: Fallback — categorize as "Other"
	return { type: "categorized", transaction: createFallback(passedTx) };
}

export async function categorizeAll(
	transactions: RawTransaction[],
	context: PipelineContext,
): Promise<{
	categorized: CategorizedTransaction[];
	excluded: ExcludedTransaction[];
}> {
	const categorized: CategorizedTransaction[] = [];
	const excluded: ExcludedTransaction[] = [];

	for (const tx of transactions) {
		const result = await categorizePipeline(tx, context);
		if (result.type === "categorized") {
			categorized.push(result.transaction);
		} else {
			excluded.push(result.transaction);
		}
	}

	return { categorized, excluded };
}

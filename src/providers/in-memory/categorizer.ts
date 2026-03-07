import { type Result, err, ok } from "@f0rbit/corpus";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type {
	AiCategorizationRequest,
	AiCategorizationResult,
	AiCategorizer,
	Category,
	MerchantMapping,
} from "../types.js";

export class InMemoryAiCategorizer implements AiCategorizer {
	readonly name = "in-memory-categorizer";

	/** Per-externalId result overrides */
	private results = new Map<string, { item: string; category: Category; notes: string }>();

	/** Default category for transactions not explicitly configured */
	private defaultCategory: Category = "Shopping";

	/** Default item name generator — uses description by default */
	private defaultItemFn: (description: string) => string = (d) => d;

	/** Suggested mappings to return */
	private mappings: MerchantMapping[] = [];

	/** Record of all categorize() calls received */
	calls: AiCategorizationRequest[] = [];

	/** When true, next categorize() call returns an error */
	failNext = false;

	setResult(externalId: string, item: string, category: Category, notes = ""): void {
		this.results.set(externalId, { item, category, notes });
	}

	setDefaultCategory(category: Category): void {
		this.defaultCategory = category;
	}

	setSuggestedMappings(mappings: MerchantMapping[]): void {
		this.mappings = mappings;
	}

	async categorize(request: AiCategorizationRequest): Promise<Result<AiCategorizationResult, ProviderError>> {
		this.calls.push(request);

		if (this.failNext) {
			this.failNext = false;
			return err(errors.apiError(500, "Simulated AI categorization failure"));
		}

		const categorizations = request.uncategorized.map((tx) => {
			const override = this.results.get(tx.externalId);
			if (override) {
				return {
					externalId: tx.externalId,
					item: override.item,
					category: override.category,
					notes: override.notes,
				};
			}
			return {
				externalId: tx.externalId,
				item: this.defaultItemFn(tx.description),
				category: this.defaultCategory,
				notes: "",
			};
		});

		const suggestedMappings =
			this.mappings.length > 0
				? this.mappings.map((m) => ({ match: m.match, item: m.item, category: m.category }))
				: categorizations.map((c) => ({
						match: c.item.toUpperCase(),
						item: c.item,
						category: c.category,
					}));

		return ok({
			categorizations,
			suggestedMappings,
		});
	}
}

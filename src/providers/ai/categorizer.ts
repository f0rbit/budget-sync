import Anthropic from "@anthropic-ai/sdk";
import { type Result, err, ok, try_catch_async } from "@f0rbit/corpus";
import { z } from "zod";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import { type AiCategorizationRequest, type AiCategorizationResult, type AiCategorizer, CATEGORIES } from "../types.js";

const CATEGORIZATION_PROMPT = `You are a financial transaction categorizer for a personal budget tracker.

You will receive a list of uncategorized bank transactions. For each transaction, you must:
1. Assign it to the correct category from the valid list
2. Create a clean, human-readable item name (e.g., "Water bill" instead of "Osko Withdrawal 04Mar09:39 Water Max Bruce")
3. Suggest a general substring pattern that would match similar transactions in the future

Rules:
- Use ONLY the categories provided — do not invent new ones
- Item names should be short and readable (e.g., "Miso Hungry", "Uber", "Water bill")
- Suggested match patterns should be UPPERCASE substrings that uniquely identify the merchant (e.g., "MISO HUNGRY", "FIREFLY BRISBANE")
- For PayPal transactions, try to identify the underlying merchant from context
- For Osko/bank transfers, identify the purpose from the description
- When unsure, use "Other" as the category
- Return valid JSON only, no markdown or explanation`;

// Zod schema for AI response validation
const aiCategorizationResponseSchema = z.object({
	categorizations: z.array(
		z.object({
			externalId: z.string(),
			item: z.string(),
			category: z.enum(CATEGORIES),
			notes: z.string().default(""),
		}),
	),
	suggestedMappings: z.array(
		z.object({
			match: z.string(),
			item: z.string(),
			category: z.enum(CATEGORIES),
		}),
	),
});

function extractJson(text: string): string {
	const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlock?.[1]) return codeBlock[1].trim();
	return text.trim();
}

function mapApiError(error: unknown): ProviderError {
	if (error instanceof Anthropic.AuthenticationError) {
		return errors.authFailed(error.message);
	}
	if (error instanceof Anthropic.RateLimitError) {
		return errors.rateLimited(error.message);
	}
	if (error instanceof Anthropic.APIError) {
		return errors.apiError(error.status, error.message);
	}
	return errors.apiError(0, String(error));
}

function buildUserPrompt(request: AiCategorizationRequest): string {
	const lines: string[] = [];

	// Categories
	lines.push("## Valid Categories");
	for (const cat of request.context.categories) {
		lines.push(`- **${cat.name}**: ${cat.description}`);
	}
	lines.push("");

	// Existing mappings for reference
	if (request.context.existingMappings.length > 0) {
		lines.push("## Known Merchant Mappings (for reference — do NOT duplicate these)");
		for (const m of request.context.existingMappings) {
			lines.push(`- "${m.match}" → ${m.item} [${m.category}]`);
		}
		lines.push("");
	}

	// Context: recently categorized transactions
	if (request.context.categorizedTransactions.length > 0) {
		lines.push("## Recently Categorized Transactions (for context)");
		for (const tx of request.context.categorizedTransactions) {
			lines.push(`- ${tx.date} $${tx.amount.toFixed(2)} — ${tx.item} [${tx.category}]`);
		}
		lines.push("");
	}

	// Transactions to categorize
	lines.push("## Transactions to Categorize");
	lines.push("");
	for (const tx of request.uncategorized) {
		lines.push(`- externalId: "${tx.externalId}"`);
		lines.push(`  description: "${tx.description}"`);
		lines.push(`  amount: $${tx.amount.toFixed(2)}`);
		lines.push(`  date: ${tx.date}`);
		lines.push("");
	}

	lines.push("Return JSON matching this schema:");
	lines.push(`{
  "categorizations": [
    { "externalId": "...", "item": "Clean Name", "category": "ValidCategory", "notes": "" }
  ],
  "suggestedMappings": [
    { "match": "UPPERCASE PATTERN", "item": "Clean Name", "category": "ValidCategory" }
  ]
}`);

	return lines.join("\n");
}

export class AnthropicAiCategorizer implements AiCategorizer {
	readonly name = "ai-categorizer";
	private client: Anthropic;
	private model: string;
	private maxTokens: number;

	constructor(config: { apiKey: string; model?: string; maxTokens?: number }) {
		this.client = new Anthropic({ apiKey: config.apiKey });
		this.model = config.model ?? "claude-sonnet-4-20250514";
		this.maxTokens = config.maxTokens ?? 4096;
	}

	async categorize(request: AiCategorizationRequest): Promise<Result<AiCategorizationResult, ProviderError>> {
		if (request.uncategorized.length === 0) {
			return ok({ categorizations: [], suggestedMappings: [] });
		}

		const userPrompt = buildUserPrompt(request);

		const apiResult = await try_catch_async(
			() =>
				this.client.messages.create({
					model: this.model,
					max_tokens: this.maxTokens,
					system: CATEGORIZATION_PROMPT,
					messages: [{ role: "user", content: userPrompt }],
				}),
			mapApiError,
		);

		if (!apiResult.ok) return apiResult;

		const response = apiResult.value;
		const textBlock = response.content.find((block) => block.type === "text");
		if (!textBlock || textBlock.type !== "text") {
			return err(errors.parseError("No text content in AI categorization response"));
		}

		const rawText = textBlock.text;
		const jsonStr = extractJson(rawText);

		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			return err(errors.parseError("Failed to parse JSON from AI categorization response", rawText));
		}

		const validated = aiCategorizationResponseSchema.safeParse(parsed);
		if (!validated.success) {
			return err(errors.parseError(`Invalid AI categorization response schema: ${validated.error.message}`, rawText));
		}

		return ok({
			categorizations: validated.data.categorizations,
			suggestedMappings: validated.data.suggestedMappings,
			rawResponse: rawText,
		});
	}
}

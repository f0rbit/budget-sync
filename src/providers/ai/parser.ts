import Anthropic from "@anthropic-ai/sdk";
import { type Result, err, ok, try_catch_async } from "@f0rbit/corpus";
import { z } from "zod";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type { AccountType, DocumentParser, ParsedDocument, RawTransaction } from "../types.js";
import { generateExternalId } from "../utils.js";

const DOCUMENT_PARSE_PROMPT = `You are a financial document parser. Extract all transactions from the provided document.

For each transaction, extract:
- date: in YYYY-MM-DD format
- description: the raw bank description text exactly as shown
- amount: as a positive number (never negative)
- direction: "debit" for money going out, "credit" for money coming in

Also identify the account name, institution, and type (transaction, savings, or credit) if possible.

Return valid JSON matching this schema:
{
  "transactions": [
    { "date": "YYYY-MM-DD", "description": "raw text", "amount": 123.45, "direction": "debit" | "credit" }
  ],
  "account": {
    "name": "account name if identifiable",
    "institution": "bank name if identifiable",
    "type": "transaction" | "savings" | "credit"
  },
  "notes": ["any ambiguities or issues encountered"]
}

Rules:
- Amounts must always be positive numbers
- Convert all dates to YYYY-MM-DD format
- Include ALL transactions found in the document
- Do NOT infer or assign categories
- Preserve the exact bank description text as-is`;

const aiResponseSchema = z.object({
	transactions: z.array(
		z.object({
			date: z.string(),
			description: z.string(),
			amount: z.number().positive(),
			direction: z.enum(["debit", "credit"]),
		}),
	),
	account: z
		.object({
			name: z.string().optional(),
			institution: z.string().optional(),
			type: z.enum(["transaction", "savings", "credit"]).optional(),
		})
		.optional(),
	notes: z.array(z.string()).optional(),
});

function extractJson(text: string): string {
	const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlock?.[1]) return codeBlock[1].trim();
	return text.trim();
}

function buildContentBlocks(content: string, mimeType: string): Anthropic.Messages.ContentBlockParam[] {
	if (mimeType === "application/pdf") {
		return [
			{
				type: "document",
				source: { type: "base64", media_type: "application/pdf", data: content },
			},
		];
	}

	const image_types = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
	type ImageMediaType = (typeof image_types)[number];
	if (image_types.includes(mimeType as ImageMediaType)) {
		return [
			{
				type: "image",
				source: { type: "base64", media_type: mimeType as ImageMediaType, data: content },
			},
		];
	}

	return [{ type: "text", text: content }];
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

export class AnthropicDocumentParser implements DocumentParser {
	readonly name = "ai";
	private client: Anthropic;
	private model: string;
	private maxTokens: number;

	constructor(config: { apiKey: string; model?: string; maxTokens?: number }) {
		this.client = new Anthropic({ apiKey: config.apiKey });
		this.model = config.model ?? "claude-sonnet-4-20250514";
		this.maxTokens = config.maxTokens ?? 8192;
	}

	async parse(
		content: string,
		mimeType: string,
		accountHint?: { accountName?: string; accountType?: AccountType },
	): Promise<Result<ParsedDocument, ProviderError>> {
		const contentBlocks = buildContentBlocks(content, mimeType);

		const userContent: Anthropic.Messages.ContentBlockParam[] = [...contentBlocks];

		if (accountHint) {
			const hints = [
				accountHint.accountName ? `name=${accountHint.accountName}` : null,
				accountHint.accountType ? `type=${accountHint.accountType}` : null,
			]
				.filter(Boolean)
				.join(", ");
			if (hints) {
				userContent.push({ type: "text", text: `Account hint: ${hints}` });
			}
		}

		const apiResult = await try_catch_async(
			() =>
				this.client.messages.create({
					model: this.model,
					max_tokens: this.maxTokens,
					system: DOCUMENT_PARSE_PROMPT,
					messages: [{ role: "user", content: userContent }],
				}),
			mapApiError,
		);

		if (!apiResult.ok) return apiResult;

		const response = apiResult.value;
		const textBlock = response.content.find((block) => block.type === "text");
		if (!textBlock || textBlock.type !== "text") {
			return err(errors.parseError("No text content in AI response"));
		}

		const rawText = textBlock.text;
		const jsonStr = extractJson(rawText);

		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			return err(errors.parseError("Failed to parse JSON from AI response", rawText));
		}

		const validated = aiResponseSchema.safeParse(parsed);
		if (!validated.success) {
			return err(errors.parseError(`Invalid AI response schema: ${validated.error.message}`, rawText));
		}

		const data = validated.data;

		const transactions: RawTransaction[] = data.transactions.map((tx) => ({
			id: generateExternalId("ai", {
				date: tx.date,
				description: tx.description,
				amount: tx.amount,
				direction: tx.direction,
			}),
			description: tx.description,
			amount: tx.amount,
			direction: tx.direction,
			transactionDate: tx.date,
			postDate: tx.date,
			accountId: "pending",
		}));

		return ok({
			transactions,
			account: data.account,
			notes: data.notes,
			rawResponse: rawText,
		});
	}
}

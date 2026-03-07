import { z } from "zod";
import { ACCOUNT_TYPES, CATEGORIES, CONTRIBUTION_TYPES, TRANSACTION_DIRECTIONS } from "../providers/types.js";

// === Raw transaction snapshot (what providers return) ===

export const rawTransactionSchema = z.object({
	id: z.string(),
	description: z.string(),
	amount: z.number(),
	direction: z.enum(TRANSACTION_DIRECTIONS),
	transactionDate: z.string(),
	postDate: z.string(),
	accountId: z.string(),
});

export const rawTransactionsSnapshotSchema = z.object({
	accountId: z.string(),
	provider: z.string(),
	dateRange: z.object({
		from: z.string(),
		to: z.string(),
	}),
	fetchedAt: z.string(),
	transactions: z.array(rawTransactionSchema),
});

export type RawTransactionsSnapshot = z.infer<typeof rawTransactionsSnapshotSchema>;

// === Raw accounts snapshot ===

export const rawAccountSchema = z.object({
	id: z.string(),
	name: z.string(),
	institution: z.string(),
	type: z.enum(ACCOUNT_TYPES),
	balance: z.number().optional(),
	availableBalance: z.number().optional(),
});

export const rawAccountsSnapshotSchema = z.object({
	provider: z.string(),
	fetchedAt: z.string(),
	accounts: z.array(rawAccountSchema),
});

export type RawAccountsSnapshot = z.infer<typeof rawAccountsSnapshotSchema>;

// === Raw balances snapshot ===

export const rawBalanceSchema = z.object({
	accountId: z.string(),
	balance: z.number(),
	available: z.number().optional(),
	asOf: z.string(),
});

export const rawBalancesSnapshotSchema = z.object({
	provider: z.string(),
	fetchedAt: z.string(),
	balances: z.array(rawBalanceSchema),
});

export type RawBalancesSnapshot = z.infer<typeof rawBalancesSnapshotSchema>;

// === Sync result snapshot (output of categorization pipeline) ===

export const categorizedTransactionSchema = z.object({
	externalId: z.string(),
	date: z.string(),
	postDate: z.string(),
	rawDescription: z.string(),
	item: z.string(),
	amount: z.number(),
	direction: z.enum(TRANSACTION_DIRECTIONS),
	category: z.enum(CATEGORIES),
	notes: z.string(),
	excluded: z.boolean(),
	excludeReason: z.string().optional(),
	accountId: z.string(),
});

export const syncResultSnapshotSchema = z.object({
	syncRunId: z.string(),
	provider: z.string(),
	processedAt: z.string(),
	categorized: z.array(categorizedTransactionSchema),
	excluded: z.array(
		z.object({
			externalId: z.string(),
			rawDescription: z.string(),
			amount: z.number(),
			direction: z.enum(TRANSACTION_DIRECTIONS),
			reason: z.string(),
		}),
	),
	stats: z.object({
		totalFetched: z.number(),
		categorized: z.number(),
		excluded: z.number(),
		duplicatesSkipped: z.number(),
	}),
});

export type SyncResultSnapshot = z.infer<typeof syncResultSnapshotSchema>;

// === Raw contributions snapshot (from super import/API) ===

export const rawContributionSchema = z.object({
	id: z.string(),
	date: z.string(),
	type: z.enum(CONTRIBUTION_TYPES),
	amount: z.number(),
	description: z.string().optional(),
});

export const rawContributionsSnapshotSchema = z.object({
	accountId: z.string(),
	provider: z.string(),
	fetchedAt: z.string(),
	balance: z.object({
		amount: z.number(),
		asOf: z.string(),
	}),
	contributions: z.array(rawContributionSchema),
});

export type RawContributionsSnapshot = z.infer<typeof rawContributionsSnapshotSchema>;

// === Raw document snapshot (full document content for ingestion) ===

export const rawDocumentSnapshotSchema = z.object({
	/** Original filename */
	filename: z.string(),
	/** MIME type of the document */
	mimeType: z.string(),
	/** SHA-256 hash of the original file content */
	contentHash: z.string(),
	/** File size in bytes */
	sizeBytes: z.number().int().nonnegative(),
	/** When the document was ingested */
	ingestedAt: z.string(),
	/** Full document content — base64 for binary, raw text for text formats */
	content: z.string(),
	/** Whether content is base64-encoded (true for PDFs, images) or raw text (CSVs, text) */
	isBase64: z.boolean(),
});

export type RawDocumentSnapshot = z.infer<typeof rawDocumentSnapshotSchema>;

// === AI parse result snapshot (what the AI extracted from the document) ===

export const aiParseResultSnapshotSchema = z.object({
	/** Which parser produced this result */
	parser: z.string(),
	/** AI model used (e.g., "claude-sonnet-4-20250514") */
	model: z.string().optional(),
	/** When parsing was performed */
	parsedAt: z.string(),
	/** Extracted transactions */
	transactions: z.array(rawTransactionSchema),
	/** Account info inferred from the document */
	account: z
		.object({
			name: z.string().optional(),
			institution: z.string().optional(),
			type: z.enum(ACCOUNT_TYPES).optional(),
		})
		.optional(),
	/** Notes about ambiguities or issues */
	notes: z.array(z.string()).optional(),
	/** Raw AI response for auditing */
	rawResponse: z.string().optional(),
});

export type AiParseResultSnapshot = z.infer<typeof aiParseResultSnapshotSchema>;

// === Computation snapshot (materialized state after ingestion) ===

export const computationSnapshotSchema = z.object({
	/** ID of the ingest/sync run that triggered this computation */
	ingestRunId: z.string(),
	/** When computation was performed */
	computedAt: z.string(),
	/** Net worth breakdown at time of computation */
	netWorth: z.object({
		total: z.number(),
		transaction: z.number(),
		savings: z.number(),
		credit: z.number(),
		super: z.number(),
	}),
	/** Per-account balances at time of computation */
	accountBalances: z.array(
		z.object({
			accountId: z.string(),
			accountName: z.string(),
			accountType: z.enum(ACCOUNT_TYPES),
			balance: z.number(),
		}),
	),
	/** Summary of what was materialized */
	materialization: z.object({
		transactionsCreated: z.number(),
		transactionsExcluded: z.number(),
		transactionsSkipped: z.number(),
		snapshotsUpserted: z.number(),
	}),
});

export type ComputationSnapshot = z.infer<typeof computationSnapshotSchema>;

// === AI categorization result snapshot (AI-assigned categories for uncategorized transactions) ===

export const aiCategorizationResultSnapshotSchema = z.object({
	/** Which categorizer produced this result */
	categorizer: z.string(),
	/** When categorization was performed */
	categorizedAt: z.string(),
	/** Summary of the request */
	request: z.object({
		uncategorizedCount: z.number(),
		contextTransactionCount: z.number(),
	}),
	/** The categorization result */
	result: z.object({
		categorizations: z.array(
			z.object({
				externalId: z.string(),
				item: z.string(),
				category: z.enum(CATEGORIES),
				notes: z.string(),
			}),
		),
		suggestedMappings: z.array(
			z.object({
				match: z.string(),
				item: z.string(),
				category: z.enum(CATEGORIES),
			}),
		),
	}),
	/** Raw AI response for auditing */
	rawResponse: z.string().optional(),
});

export type AiCategorizationResultSnapshot = z.infer<typeof aiCategorizationResultSnapshotSchema>;

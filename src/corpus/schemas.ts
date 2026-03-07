import { z } from "zod";
import { ACCOUNT_TYPES, CATEGORIES, TRANSACTION_DIRECTIONS } from "../providers/types.js";

// === Raw transaction snapshot (what Basiq/CSV returns) ===

export const rawTransactionSchema = z.object({
	id: z.string(),
	description: z.string(),
	amount: z.number(),
	direction: z.enum(TRANSACTION_DIRECTIONS),
	transactionDate: z.string(),
	postDate: z.string(),
	accountId: z.string(),
	enrichment: z
		.object({
			merchantName: z.string().optional(),
			category: z.string().optional(),
			location: z.string().optional(),
		})
		.optional(),
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

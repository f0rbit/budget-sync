import { z } from "zod";

// Token response
export const basiqTokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.string(),
	expires_in: z.number(),
});
export type BasiqTokenResponse = z.infer<typeof basiqTokenResponseSchema>;

// Account from Basiq
export const basiqAccountSchema = z.object({
	type: z.string(),
	id: z.string(),
	attributes: z.object({
		accountNo: z.string().optional(),
		name: z.string(),
		balance: z.string().optional(),
		availableFunds: z.string().optional(),
		class: z
			.object({
				type: z.string().optional(),
				product: z.string().optional(),
			})
			.optional(),
		institution: z.string().optional(),
		status: z.string().optional(),
	}),
});
export type BasiqAccount = z.infer<typeof basiqAccountSchema>;

export const basiqAccountsResponseSchema = z.object({
	type: z.literal("list"),
	data: z.array(basiqAccountSchema),
	links: z
		.object({
			self: z.string().optional(),
			next: z.string().optional(),
		})
		.optional(),
});
export type BasiqAccountsResponse = z.infer<typeof basiqAccountsResponseSchema>;

// Transaction from Basiq
export const basiqTransactionSchema = z.object({
	type: z.string(),
	id: z.string(),
	attributes: z.object({
		description: z.string(),
		amount: z.string(),
		account: z.string(),
		direction: z.enum(["debit", "credit"]),
		class: z.string().optional(),
		transactionDate: z.string(),
		postDate: z.string().optional(),
		status: z.string().optional(),
		enrich: z
			.object({
				merchant: z
					.object({
						businessName: z.string().optional(),
						ABN: z.string().optional(),
					})
					.optional(),
				category: z
					.object({
						anzsic: z
							.object({
								code: z.string().optional(),
								title: z.string().optional(),
							})
							.optional(),
					})
					.optional(),
				location: z
					.object({
						formattedAddress: z.string().optional(),
					})
					.optional(),
			})
			.optional(),
	}),
});
export type BasiqTransaction = z.infer<typeof basiqTransactionSchema>;

export const basiqTransactionsResponseSchema = z.object({
	type: z.literal("list"),
	data: z.array(basiqTransactionSchema),
	links: z
		.object({
			self: z.string().optional(),
			next: z.string().optional(),
		})
		.optional(),
});
export type BasiqTransactionsResponse = z.infer<typeof basiqTransactionsResponseSchema>;

// Enrichment response
export const basiqEnrichResponseSchema = z.object({
	data: z.array(
		z.object({
			type: z.string(),
			attributes: z.object({
				merchant: z
					.object({
						businessName: z.string().optional(),
					})
					.optional(),
				category: z.string().optional(),
				location: z
					.object({
						formattedAddress: z.string().optional(),
					})
					.optional(),
			}),
		}),
	),
});
export type BasiqEnrichResponse = z.infer<typeof basiqEnrichResponseSchema>;

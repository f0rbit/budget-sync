import { type Result, ok } from "@f0rbit/corpus";
import type { RawContributionsSnapshot } from "../corpus/schemas.js";
import type { AppContext } from "../db/client.js";
import type { DbError, ProviderError } from "../errors.js";
import type { DateRange, SuperProvider } from "../providers/types.js";
import { upsertAccount } from "./account-service.js";
import { insertContributions } from "./contribution-service.js";
import { upsertSnapshot } from "./snapshot-service.js";

export interface SuperSyncOptions {
	dateFrom?: string;
	dateTo?: string;
	accountName?: string;
	verbose?: boolean;
}

export interface SuperSyncSummary {
	accountId: string;
	accountName: string;
	balance: number;
	balanceDate: string;
	contributionsInserted: number;
	contributionsSkipped: number;
}

type SuperSyncError = ProviderError | DbError;

export async function syncSuper(
	ctx: AppContext,
	provider: SuperProvider,
	options?: SuperSyncOptions,
): Promise<Result<SuperSyncSummary, SuperSyncError>> {
	const today = new Date().toISOString().slice(0, 10);
	const now = new Date().toISOString();

	// Step 1: Authenticate
	const authResult = await provider.authenticate();
	if (!authResult.ok) return authResult;

	// Step 2: Get balance
	const balanceResult = await provider.getBalance();
	if (!balanceResult.ok) return balanceResult;
	const balance = balanceResult.value;

	// Step 3: Get contributions
	const dateRange: DateRange = {
		from: options?.dateFrom ?? "1970-01-01",
		to: options?.dateTo ?? today,
	};
	const contributionsResult = await provider.getContributions(dateRange);
	if (!contributionsResult.ok) return contributionsResult;
	const contributions = contributionsResult.value;

	// Step 4: Snapshot to corpus
	const snapshot: RawContributionsSnapshot = {
		accountId: balance.accountId,
		provider: provider.name,
		fetchedAt: now,
		balance: {
			amount: balance.balance,
			asOf: balance.asOf,
		},
		contributions: contributions.map((c) => ({
			id: c.id,
			date: c.date,
			type: c.type,
			amount: c.amount,
			description: c.description,
		})),
	};
	await ctx.corpus.stores["raw-contributions"].put(snapshot, {
		tags: [`provider:${provider.name}`, `date:${today}`],
	});

	// Step 5: Upsert account
	const accountName = options?.accountName ?? "Super Fund";
	const accountResult = await upsertAccount(ctx.db, provider.name, {
		id: balance.accountId,
		name: accountName,
		institution: "Super",
		type: "super",
	});
	if (!accountResult.ok) return accountResult;
	const internalAccountId = accountResult.value.id;

	// Step 6: Upsert balance snapshot (non-fatal)
	await upsertSnapshot(ctx.db, {
		accountId: internalAccountId,
		date: balance.asOf,
		balance: balance.balance,
	});

	// Step 7: Insert contributions (non-fatal)
	let contributionsInserted = 0;
	let contributionsSkipped = 0;
	const insertResult = await insertContributions(
		ctx.db,
		internalAccountId,
		contributions.map((c) => ({
			date: c.date,
			type: c.type,
			amount: c.amount,
			description: c.description,
		})),
	);
	if (insertResult.ok) {
		contributionsInserted = insertResult.value.inserted;
		contributionsSkipped = insertResult.value.skipped;
	}

	// Step 8: Return summary
	return ok({
		accountId: internalAccountId,
		accountName,
		balance: balance.balance,
		balanceDate: balance.asOf,
		contributionsInserted,
		contributionsSkipped,
	});
}

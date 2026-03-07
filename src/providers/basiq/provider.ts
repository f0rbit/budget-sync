import { type Result, err, ok } from "@f0rbit/corpus";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type {
	AccountBalance,
	AccountInfo,
	AccountType,
	BankProvider,
	DateRange,
	EnrichmentData,
	RawTransaction,
} from "../types.js";
import { BasiqClient } from "./client.js";
import type { BasiqAccount, BasiqAccountsResponse, BasiqTransaction, BasiqTransactionsResponse } from "./types.js";
import { basiqAccountsResponseSchema, basiqEnrichResponseSchema, basiqTransactionsResponseSchema } from "./types.js";

function mapAccountType(basiqType?: string): AccountType {
	switch (basiqType?.toLowerCase()) {
		case "transaction":
			return "transaction";
		case "savings":
			return "savings";
		case "credit-card":
		case "credit":
			return "credit";
		case "loan":
			return "credit";
		default:
			return "transaction";
	}
}

function mapAccount(account: BasiqAccount): AccountInfo {
	return {
		id: account.id,
		name: account.attributes.name,
		institution: account.attributes.institution ?? "Unknown",
		type: mapAccountType(account.attributes.class?.type),
		balance: account.attributes.balance ? Number.parseFloat(account.attributes.balance) : undefined,
		availableBalance: account.attributes.availableFunds
			? Number.parseFloat(account.attributes.availableFunds)
			: undefined,
	};
}

function mapTransaction(tx: BasiqTransaction): RawTransaction {
	const enrichment: EnrichmentData | undefined = tx.attributes.enrich
		? {
				merchantName: tx.attributes.enrich.merchant?.businessName,
				category: tx.attributes.enrich.category?.anzsic?.title,
				location: tx.attributes.enrich.location?.formattedAddress,
			}
		: undefined;

	return {
		id: tx.id,
		description: tx.attributes.description,
		amount: Math.abs(Number.parseFloat(tx.attributes.amount)),
		direction: tx.attributes.direction,
		transactionDate: tx.attributes.transactionDate,
		postDate: tx.attributes.postDate ?? tx.attributes.transactionDate,
		accountId: tx.attributes.account,
		enrichment,
	};
}

export class BasiqBankProvider implements BankProvider {
	readonly name = "basiq";

	private client: BasiqClient;
	private userId: string;

	constructor(config: { apiUrl: string; apiKey: string; userId: string }) {
		this.client = new BasiqClient(config.apiUrl, config.apiKey);
		this.userId = config.userId;
	}

	async authenticate(): Promise<Result<void, ProviderError>> {
		return this.client.authenticate();
	}

	async getAccounts(): Promise<Result<AccountInfo[], ProviderError>> {
		const result = await this.client.get<BasiqAccountsResponse>(`/users/${this.userId}/accounts`);
		if (!result.ok) return result;

		const parsed = basiqAccountsResponseSchema.safeParse(result.value);
		if (!parsed.success) {
			return err(errors.parseError("Invalid accounts response", JSON.stringify(result.value)));
		}

		return ok(parsed.data.data.map(mapAccount));
	}

	async fetchTransactions(accountId: string, range: DateRange): Promise<Result<RawTransaction[], ProviderError>> {
		const path = `/users/${this.userId}/transactions?filter=account.id.eq('${accountId}'),transaction.transactionDate.bt('${range.from}','${range.to}')`;

		const result = await this.client.getAllPages<BasiqTransactionsResponse, BasiqTransaction>(
			path,
			(page) => {
				const parsed = basiqTransactionsResponseSchema.safeParse(page);
				return parsed.success ? parsed.data.data : [];
			},
			(page) => {
				const parsed = basiqTransactionsResponseSchema.safeParse(page);
				return parsed.success ? parsed.data.links?.next : undefined;
			},
		);

		if (!result.ok) return result;

		return ok(result.value.map(mapTransaction));
	}

	async getAccountBalances(): Promise<Result<AccountBalance[], ProviderError>> {
		const accountsResult = await this.getAccounts();
		if (!accountsResult.ok) return accountsResult;

		const today = new Date().toISOString().slice(0, 10);
		const balances: AccountBalance[] = accountsResult.value
			.filter((a): a is typeof a & { balance: number } => a.balance !== undefined)
			.map((a) => ({
				accountId: a.id,
				balance: a.balance,
				available: a.availableBalance,
				asOf: today,
			}));

		return ok(balances);
	}

	async enrichTransaction(description: string): Promise<Result<EnrichmentData, ProviderError>> {
		const encoded = encodeURIComponent(description);
		const result = await this.client.get<unknown>(`/enrich?q=${encoded}&institution=AU00000&country=AU`);
		if (!result.ok) return result;

		const parsed = basiqEnrichResponseSchema.safeParse(result.value);
		if (!parsed.success || parsed.data.data.length === 0) {
			return err(errors.notFound("enrichment", `No enrichment for: ${description}`));
		}

		const enrichment = parsed.data.data[0];
		if (!enrichment) {
			return err(errors.notFound("enrichment", `No enrichment for: ${description}`));
		}

		return ok({
			merchantName: enrichment.attributes.merchant?.businessName,
			category: enrichment.attributes.category,
			location: enrichment.attributes.location?.formattedAddress,
		});
	}
}

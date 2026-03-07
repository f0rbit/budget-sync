import type { Result } from "@f0rbit/corpus";
import type { ProviderError } from "../errors.js";

// === Shared Value Types ===

export interface DateRange {
	from: string; // YYYY-MM-DD
	to: string; // YYYY-MM-DD
}

export const ACCOUNT_TYPES = ["transaction", "savings", "credit", "super", "investment"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const TRANSACTION_DIRECTIONS = ["debit", "credit"] as const;
export type TransactionDirection = (typeof TRANSACTION_DIRECTIONS)[number];

export const CATEGORIES = [
	"Rent",
	"Woolworths",
	"Eating Out",
	"Alcohol",
	"Subscriptions",
	"Transport",
	"Bills",
	"Health",
	"Entertainment",
	"Shopping",
	"Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SYNC_STATUSES = ["success", "partial", "failed"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const CONTRIBUTION_TYPES = ["employer", "salary_sacrifice", "voluntary", "fhss", "government"] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

// === Raw Transaction (from provider, before categorization) ===

export interface RawTransaction {
	id: string;
	description: string;
	amount: number; // Always positive
	direction: TransactionDirection;
	transactionDate: string; // YYYY-MM-DD
	postDate: string; // YYYY-MM-DD
	accountId: string;
}

// === Account Info (from provider) ===

export interface AccountInfo {
	id: string;
	name: string;
	institution: string;
	type: AccountType;
	balance?: number;
	availableBalance?: number;
}

// === Account Balance (from provider) ===

export interface AccountBalance {
	accountId: string;
	balance: number;
	available?: number;
	asOf: string; // YYYY-MM-DD
}

// === Categorized Transaction (output of pipeline) ===

export interface CategorizedTransaction {
	externalId: string;
	date: string; // YYYY-MM-DD
	postDate: string; // YYYY-MM-DD
	rawDescription: string;
	item: string;
	amount: number; // Always positive
	direction: TransactionDirection;
	category: Category;
	notes: string;
	excluded: boolean;
	excludeReason?: string;
	accountId: string;
}

// === Excluded Transaction (filtered out by pipeline) ===

export interface ExcludedTransaction {
	externalId: string;
	rawDescription: string;
	amount: number;
	direction: TransactionDirection;
	reason: string;
}

// === Merchant Mapping (from merchant-mappings.jsonc) ===

export interface MerchantMapping {
	match: string;
	item: string;
	category: Category;
	extractLocation?: boolean;
}

export interface ExclusionRule {
	match: string; // Regex pattern
	reason: string;
}

export interface MerchantMappings {
	mappings: MerchantMapping[];
	exclusions: ExclusionRule[];
}

// === Provider Interfaces ===

/**
 * BankProvider — abstracts bank transaction data access.
 *
 * Implementations:
 * - CsvBankProvider: Manual CSV import
 * - InMemoryBankProvider: Testing (in-memory arrays)
 */
export interface BankProvider {
	readonly name: string;
	authenticate(): Promise<Result<void, ProviderError>>;
	getAccounts(): Promise<Result<AccountInfo[], ProviderError>>;
	fetchTransactions(accountId: string, range: DateRange): Promise<Result<RawTransaction[], ProviderError>>;
	getAccountBalances(): Promise<Result<AccountBalance[], ProviderError>>;
}

// === Investment Provider (M3 — interface defined now for forward-compatibility) ===

export interface Holding {
	ticker: string;
	name: string;
	units: number;
	purchasePrice?: number;
	currentPrice?: number;
	currentValue: number;
}

export interface InvestmentTransaction {
	id: string;
	ticker: string;
	type: "buy" | "sell" | "dividend" | "distribution";
	units: number;
	pricePerUnit: number;
	totalValue: number;
	date: string;
}

export interface InvestmentProvider {
	readonly name: string;
	authenticate(): Promise<Result<void, ProviderError>>;
	getHoldings(): Promise<Result<Holding[], ProviderError>>;
	getTransactions(range: DateRange): Promise<Result<InvestmentTransaction[], ProviderError>>;
}

// === Super Provider (M2 — interface defined now for forward-compatibility) ===

export interface SuperBalance {
	accountId: string;
	balance: number;
	asOf: string;
}

export interface SuperContribution {
	id: string;
	date: string;
	type: ContributionType;
	amount: number;
	description?: string;
}

export interface SuperProvider {
	readonly name: string;
	authenticate(): Promise<Result<void, ProviderError>>;
	getBalance(): Promise<Result<SuperBalance, ProviderError>>;
	getContributions(range: DateRange): Promise<Result<SuperContribution[], ProviderError>>;
}

// === Sync Run Summary ===

export interface SyncSummary {
	syncRunId: string;
	provider: string;
	accountsSynced: number;
	transactionsCreated: number;
	transactionsExcluded: number;
	transactionsSkipped: number; // duplicates
	snapshotsCreated: number;
	status: SyncStatus;
	duration: number; // milliseconds
	errors: string[];
}

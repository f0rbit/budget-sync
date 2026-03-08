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

// === Document Parser (AI-powered document ingestion) ===

export interface ParsedDocument {
	/** Transactions extracted from the document */
	transactions: RawTransaction[];
	/** Account info inferred from the document (if identifiable) */
	account?: {
		name?: string;
		institution?: string;
		type?: AccountType;
	};
	/** Statement/closing balance extracted from document */
	balance?: { amount: number; asOf: string };
	/** Confidence scores or notes from the AI about ambiguous entries */
	notes?: string[];
	/** Raw AI response for debugging/auditing */
	rawResponse?: string;
}

export interface DocumentParser {
	readonly name: string;
	/**
	 * Parse a document into transactions.
	 * @param content - Document content (base64 for binary, raw text for CSV/text)
	 * @param mimeType - MIME type of the document
	 * @param accountHint - Optional user-provided account identification
	 */
	parse(
		content: string,
		mimeType: string,
		accountHint?: { accountName?: string; accountType?: AccountType },
	): Promise<Result<ParsedDocument, ProviderError>>;
}

// === Category Descriptions (used in AI prompts) ===

export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
	Rent: "Housing rent payments",
	Woolworths: "Woolworths grocery runs (in-store and online)",
	"Eating Out": "Restaurants, takeaway, cafes, coffee, food delivery, paying mates back for food",
	Alcohol: "Bars, bottle shops, pub drinks. Firefly Brisbane is always Alcohol",
	Subscriptions: "Recurring digital services: Adobe, Apple, Spotify, Amazon Prime, Uber One, AWS",
	Transport: "Fuel, parking, public transit (Translink, Myki), Uber rides, e-scooters (Neuron), airport parking",
	Bills: "Utilities (water, electricity), internet (Gigacomm), phone plan (Woolies Mobile), insurance",
	Health: "Medical, pharmacy (Chemist Warehouse), gym, health insurance (GU Health)",
	Entertainment:
		"Events, concerts, museums, galleries (ACCA, NGV, QPAC, Sea Life), games (Nintendo), badminton, cinema",
	Shopping: "Clothing, electronics (JB Hi-Fi, Digidirect), homewares, gifts, accessories, Officeworks",
	Other: "Anything that doesn't fit the above categories",
};

// === AI Categorization (pipeline step for uncategorized transactions) ===

export interface AiCategorizationRequest {
	uncategorized: Array<{
		externalId: string;
		description: string;
		amount: number;
		date: string;
	}>;
	context: {
		categorizedTransactions: Array<{
			item: string;
			category: Category;
			amount: number;
			date: string;
		}>;
		categories: Array<{ name: Category; description: string }>;
		existingMappings: MerchantMapping[];
	};
}

export interface AiCategorizationResult {
	categorizations: Array<{
		externalId: string;
		item: string;
		category: Category;
		notes: string;
	}>;
	suggestedMappings: Array<{
		match: string;
		item: string;
		category: Category;
	}>;
	rawResponse?: string;
}

export interface AiCategorizer {
	readonly name: string;
	categorize(request: AiCategorizationRequest): Promise<Result<AiCategorizationResult, ProviderError>>;
}

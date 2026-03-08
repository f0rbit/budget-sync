import { createId } from "@paralleldrive/cuid2";
import type { AppConfig } from "../src/config.js";
import { createTestCorpus } from "../src/corpus/client.js";
import { type AppContext, createTestDb } from "../src/db/client.js";
import { InMemoryAiCategorizer } from "../src/providers/in-memory/categorizer.js";
import { InMemoryDocumentParser } from "../src/providers/in-memory/document-parser.js";
import { InMemorySuperProvider } from "../src/providers/in-memory/super-provider.js";
import type {
	AccountInfo,
	CategorizedTransaction,
	ContributionType,
	ParsedDocument,
	RawTransaction,
	SuperBalance,
	SuperContribution,
} from "../src/providers/types.js";

export function createTestContext(): AppContext {
	return {
		db: createTestDb(),
		corpus: createTestCorpus(),
	};
}

export function makeTransaction(overrides?: Partial<RawTransaction>): RawTransaction {
	return {
		id: createId(),
		description: "WOOLWORTHS 1234 ADELAIDE SA",
		amount: 42.5,
		direction: "debit",
		transactionDate: "2026-03-01",
		postDate: "2026-03-01",
		accountId: overrides?.accountId ?? createId(),
		...overrides,
	};
}

export function makeAccount(overrides?: Partial<AccountInfo>): AccountInfo {
	return {
		id: createId(),
		name: "Everyday Account",
		institution: "BankSA",
		type: "transaction",
		...overrides,
	};
}

export function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		db_path: ":memory:",
		corpus_dir: ":memory:",
		vault_path: "/tmp/test-vault",
		budget_dir: "Budget",
		provider: "manual",
		sync: {
			default_range_days: 30,
			auto_snapshot: true,
		},
		anthropic: {
			model: "claude-sonnet-4-20250514",
			max_tokens: 8192,
		},
		rent: makeRentConfig(),
		...overrides,
	};
}

export function makeRentConfig() {
	return {
		solo_start_date: "2026-03-01",
		solo_weekly_amount: 650,
		shared_roommate_contribution: 450,
		landlord_patterns: ["IPY*GRACZYKTHOMPSON"],
		debit_rent_patterns: ["Internet Withdrawal.*Rent"],
	};
}

export function makeSuperBalance(overrides?: Partial<SuperBalance>): SuperBalance {
	return {
		accountId: overrides?.accountId ?? "super-account",
		balance: 85000.0,
		asOf: "2026-03-01",
		...overrides,
	};
}

export function makeContribution(overrides?: Partial<SuperContribution>): SuperContribution {
	return {
		id: overrides?.id ?? createId(),
		date: "2026-03-01",
		type: "employer" as ContributionType,
		amount: 1200.0,
		description: "Monthly employer contribution",
		...overrides,
	};
}

export function createTestSuperProvider(options?: {
	balance?: SuperBalance;
	contributions?: SuperContribution[];
}): InMemorySuperProvider {
	const provider = new InMemorySuperProvider();
	if (options?.balance) provider.setBalance(options.balance);
	if (options?.contributions) provider.addContributions(...options.contributions);
	return provider;
}

export function createTestDocumentParser(options?: {
	defaultResult?: ParsedDocument;
}): InMemoryDocumentParser {
	const parser = new InMemoryDocumentParser();
	if (options?.defaultResult) parser.setDefaultResult(options.defaultResult);
	return parser;
}

export function createTestAiCategorizer(): InMemoryAiCategorizer {
	return new InMemoryAiCategorizer();
}

export function makeCategorizedTransaction(
	overrides?: Partial<CategorizedTransaction> & { externalId?: string },
): CategorizedTransaction {
	return {
		externalId: overrides?.externalId ?? createId(),
		date: "2026-03-01",
		postDate: "2026-03-01",
		rawDescription: "TEST TRANSACTION",
		item: "Test Item",
		amount: 25.0,
		direction: "debit",
		category: "Shopping",
		notes: "",
		excluded: false,
		accountId: "acc-1",
		...overrides,
	};
}

export function makeParsedDocument(overrides?: Partial<ParsedDocument>): ParsedDocument {
	return {
		transactions: overrides?.transactions ?? [
			makeTransaction({
				id: "ai-parsed-1",
				description: "WOOLWORTHS 1234 BRISBANE",
				amount: 42.5,
				direction: "debit",
				transactionDate: "2026-03-01",
				postDate: "2026-03-01",
				accountId: "pending",
			}),
			makeTransaction({
				id: "ai-parsed-2",
				description: "MCDONALDS SOUTH BRISBANE",
				amount: 15.0,
				direction: "debit",
				transactionDate: "2026-03-02",
				postDate: "2026-03-02",
				accountId: "pending",
			}),
		],
		account: overrides?.account ?? {
			name: "Everyday Account",
			institution: "BankSA",
			type: "transaction",
		},
		notes: overrides?.notes ?? [],
		rawResponse: overrides?.rawResponse ?? '{"test": "response"}',
	};
}

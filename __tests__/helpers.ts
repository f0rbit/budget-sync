import { createId } from "@paralleldrive/cuid2";
import type { AppConfig } from "../src/config.js";
import { createTestCorpus } from "../src/corpus/client.js";
import { type AppContext, createTestDb } from "../src/db/client.js";
import { InMemoryBankProvider } from "../src/providers/in-memory/provider.js";
import type { AccountBalance, AccountInfo, RawTransaction } from "../src/providers/types.js";

export function createTestContext(): AppContext {
	return {
		db: createTestDb(),
		corpus: createTestCorpus(),
	};
}

export function createTestProvider(options?: {
	transactions?: { accountId: string; items: RawTransaction[] }[];
	accounts?: AccountInfo[];
	balances?: AccountBalance[];
}) {
	const provider = new InMemoryBankProvider();
	if (options?.accounts) provider.addAccounts(...options.accounts);
	if (options?.transactions) {
		for (const { accountId, items } of options.transactions) {
			provider.addTransactions(accountId, ...items);
		}
	}
	if (options?.balances) provider.setBalances(options.balances);
	return provider;
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

export function makeBalance(overrides?: Partial<AccountBalance>): AccountBalance {
	return {
		accountId: overrides?.accountId ?? createId(),
		balance: 1500.0,
		available: 1400.0,
		asOf: "2026-03-01",
		...overrides,
	};
}

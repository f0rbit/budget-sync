import { type Result, err, ok } from "@f0rbit/corpus";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type { AccountBalance, AccountInfo, BankProvider, DateRange, RawTransaction } from "../types.js";

export class InMemoryBankProvider implements BankProvider {
	readonly name = "in-memory";

	private _accounts: AccountInfo[] = [];
	private _transactions: Map<string, RawTransaction[]> = new Map();
	private _balances: AccountBalance[] = [];
	private _authenticated = false;

	failNextAuth = false;
	failNextFetch = false;
	failNextBalances = false;

	// --- Data loading helpers ---

	addAccounts(...accounts: AccountInfo[]): void {
		this._accounts.push(...accounts);
	}

	addTransactions(accountId: string, ...transactions: RawTransaction[]): void {
		const existing = this._transactions.get(accountId) ?? [];
		existing.push(...transactions);
		this._transactions.set(accountId, existing);
	}

	setBalances(balances: AccountBalance[]): void {
		this._balances = balances;
	}

	// --- BankProvider interface ---

	async authenticate(): Promise<Result<void, ProviderError>> {
		if (this.failNextAuth) {
			this.failNextAuth = false;
			return err(errors.authFailed("Simulated auth failure"));
		}
		this._authenticated = true;
		return ok(undefined);
	}

	async getAccounts(): Promise<Result<AccountInfo[], ProviderError>> {
		if (!this._authenticated) {
			return err(errors.authFailed("Not authenticated"));
		}
		return ok([...this._accounts]);
	}

	async fetchTransactions(accountId: string, range: DateRange): Promise<Result<RawTransaction[], ProviderError>> {
		if (!this._authenticated) {
			return err(errors.authFailed("Not authenticated"));
		}
		if (this.failNextFetch) {
			this.failNextFetch = false;
			return err(errors.apiError(500, "Simulated fetch failure"));
		}

		const accountTxs = this._transactions.get(accountId) ?? [];
		const filtered = accountTxs.filter((tx) => tx.transactionDate >= range.from && tx.transactionDate <= range.to);

		return ok(filtered);
	}

	async getAccountBalances(): Promise<Result<AccountBalance[], ProviderError>> {
		if (!this._authenticated) {
			return err(errors.authFailed("Not authenticated"));
		}
		if (this.failNextBalances) {
			this.failNextBalances = false;
			return err(errors.apiError(500, "Simulated balance fetch failure"));
		}
		return ok([...this._balances]);
	}
}

import { type Result, err, ok } from "@f0rbit/corpus";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type { DateRange, SuperBalance, SuperContribution, SuperProvider } from "../types.js";

export class InMemorySuperProvider implements SuperProvider {
	readonly name = "in-memory-super";

	private _balance: SuperBalance | null = null;
	private _contributions: SuperContribution[] = [];
	private _authenticated = false;

	failNextAuth = false;
	failNextBalance = false;
	failNextContributions = false;

	// --- Data loading helpers ---

	setBalance(balance: SuperBalance): void {
		this._balance = balance;
	}

	addContributions(...contributions: SuperContribution[]): void {
		this._contributions.push(...contributions);
	}

	// --- SuperProvider interface ---

	async authenticate(): Promise<Result<void, ProviderError>> {
		if (this.failNextAuth) {
			this.failNextAuth = false;
			return err(errors.authFailed("Simulated auth failure"));
		}
		this._authenticated = true;
		return ok(undefined);
	}

	async getBalance(): Promise<Result<SuperBalance, ProviderError>> {
		if (!this._authenticated) {
			return err(errors.authFailed("Not authenticated"));
		}
		if (this.failNextBalance) {
			this.failNextBalance = false;
			return err(errors.apiError(500, "Simulated balance fetch failure"));
		}
		if (!this._balance) {
			return err(errors.notFound("balance", "No super balance configured"));
		}
		return ok({ ...this._balance });
	}

	async getContributions(range: DateRange): Promise<Result<SuperContribution[], ProviderError>> {
		if (!this._authenticated) {
			return err(errors.authFailed("Not authenticated"));
		}
		if (this.failNextContributions) {
			this.failNextContributions = false;
			return err(errors.apiError(500, "Simulated contributions fetch failure"));
		}
		const filtered = this._contributions.filter((c) => c.date >= range.from && c.date <= range.to);
		return ok(filtered);
	}
}

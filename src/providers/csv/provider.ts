import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Result, err, ok, try_catch } from "@f0rbit/corpus";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type { AccountBalance, AccountInfo, BankProvider, DateRange, RawTransaction } from "../types.js";

export class CsvBankProvider implements BankProvider {
	readonly name = "csv";

	private filePath: string;
	private accountName: string;
	private accountType: "transaction" | "savings" | "credit";
	private transactions: RawTransaction[] = [];
	private latestBalance: number | null = null;
	private parsed = false;

	constructor(options: {
		filePath: string;
		accountName: string;
		accountType?: "transaction" | "savings" | "credit";
	}) {
		this.filePath = resolve(options.filePath);
		this.accountName = options.accountName;
		this.accountType = options.accountType ?? "transaction";
	}

	private get accountId(): string {
		return `csv-${this.accountName.toLowerCase().replace(/\s+/g, "-")}`;
	}

	async authenticate(): Promise<Result<void, ProviderError>> {
		if (!existsSync(this.filePath)) {
			return err(errors.authFailed(`CSV file not found: ${this.filePath}`));
		}

		const readResult = try_catch(
			() => readFileSync(this.filePath, "utf-8"),
			(e) => errors.authFailed(`Failed to read CSV file: ${e}`),
		);
		if (!readResult.ok) return readResult;

		const parseResult = this.parseCSV(readResult.value);
		if (!parseResult.ok) return parseResult;

		this.transactions = parseResult.value;
		this.parsed = true;
		return ok(undefined);
	}

	async getAccounts(): Promise<Result<AccountInfo[], ProviderError>> {
		if (!this.parsed) return err(errors.authFailed("Not authenticated — call authenticate() first"));

		return ok([
			{
				id: this.accountId,
				name: this.accountName,
				institution: "CSV Import",
				type: this.accountType,
				balance: this.latestBalance ?? undefined,
			},
		]);
	}

	async fetchTransactions(_accountId: string, range: DateRange): Promise<Result<RawTransaction[], ProviderError>> {
		if (!this.parsed) return err(errors.authFailed("Not authenticated"));

		const filtered = this.transactions.filter(
			(tx) => tx.transactionDate >= range.from && tx.transactionDate <= range.to,
		);

		return ok(filtered);
	}

	async getAccountBalances(): Promise<Result<AccountBalance[], ProviderError>> {
		if (!this.parsed) return err(errors.authFailed("Not authenticated"));
		if (this.latestBalance === null) return ok([]);

		return ok([
			{
				accountId: this.accountId,
				balance: this.latestBalance,
				asOf: new Date().toISOString().slice(0, 10),
			},
		]);
	}

	// === Private helpers ===

	private parseCSV(content: string): Result<RawTransaction[], ProviderError> {
		const lines = content.split("\n").filter((line) => line.trim().length > 0);

		if (lines.length < 2) {
			return err(errors.parseError("CSV file has no data rows"));
		}

		const dataLines = lines.slice(1);
		const transactions: RawTransaction[] = [];

		for (let i = 0; i < dataLines.length; i++) {
			const line = dataLines[i];
			if (!line) continue;

			const parseResult = this.parseLine(line);
			if (!parseResult.ok) continue; // skip malformed lines

			transactions.push(parseResult.value);

			// First data line has the most recent balance
			if (i === 0) {
				const parts = line.split(",");
				const balanceStr = parts[4]?.trim();
				if (balanceStr) {
					this.latestBalance = Number.parseFloat(balanceStr);
				}
			}
		}

		return ok(transactions);
	}

	private parseLine(line: string): Result<RawTransaction, ProviderError> {
		const parts = line.split(",");
		if (parts.length < 4) {
			return err(errors.parseError(`Malformed CSV line: ${line}`));
		}

		const [dateStr, description, debitStr, creditStr] = parts;
		if (!dateStr || !description) {
			return err(errors.parseError(`Missing date or description: ${line}`));
		}

		// DD/MM/YYYY → YYYY-MM-DD
		const dateParts = dateStr.trim().split("/");
		if (dateParts.length !== 3) {
			return err(errors.parseError(`Invalid date format: ${dateStr}`));
		}
		const [day, month, year] = dateParts;
		if (!day || !month || !year) {
			return err(errors.parseError(`Invalid date format: ${dateStr}`));
		}
		const isoDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

		const debit = debitStr?.trim() ? Number.parseFloat(debitStr.trim()) : 0;
		const credit = creditStr?.trim() ? Number.parseFloat(creditStr.trim()) : 0;

		const direction = debit > 0 ? ("debit" as const) : ("credit" as const);
		const amount = debit > 0 ? debit : credit;

		if (amount === 0) {
			return err(errors.parseError(`Zero amount transaction: ${line}`));
		}

		const hash = createHash("sha256")
			.update(`${isoDate}|${description.trim()}|${amount}|${direction}`)
			.digest("hex")
			.substring(0, 16);

		return ok({
			id: `csv-${hash}`,
			description: description.trim(),
			amount,
			direction,
			transactionDate: isoDate,
			postDate: isoDate,
			accountId: this.accountId,
		});
	}
}

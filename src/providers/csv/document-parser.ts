import { createHash } from "node:crypto";
import { type Result, err, ok } from "@f0rbit/corpus";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type { AccountType, DocumentParser, ParsedDocument, RawTransaction } from "../types.js";

export class CsvDocumentParser implements DocumentParser {
	readonly name = "csv";

	async parse(
		content: string,
		_mimeType: string,
		accountHint?: { accountName?: string; accountType?: AccountType },
	): Promise<Result<ParsedDocument, ProviderError>> {
		const accountName = accountHint?.accountName ?? "CSV Import";
		const accountType = accountHint?.accountType ?? "transaction";

		const lines = content.split("\n").filter((line) => line.trim().length > 0);

		if (lines.length < 2) {
			return err({ code: "PARSE_ERROR", message: "CSV file has no data rows" });
		}

		const dataLines = lines.slice(1); // skip header
		const transactions = [];
		let latestBalance: number | undefined;

		for (let i = 0; i < dataLines.length; i++) {
			const line = dataLines[i];
			if (!line) continue;

			const result = parseCsvLine(line);
			if (!result.ok) continue; // skip malformed lines

			transactions.push(result.value);

			// First data line may have balance in column 5
			if (i === 0) {
				const parts = line.split(",");
				const balanceStr = parts[4]?.trim();
				if (balanceStr) {
					const bal = Number.parseFloat(balanceStr);
					if (!Number.isNaN(bal)) latestBalance = bal;
				}
			}
		}

		return ok({
			transactions,
			account: {
				name: accountName,
				institution: "CSV Import",
				type: accountType,
			},
			notes: latestBalance !== undefined ? [`Latest balance: $${latestBalance.toFixed(2)}`] : [],
		});
	}
}

// === Shared CSV parsing (extracted from CsvBankProvider) ===

function parseCsvLine(line: string): Result<RawTransaction, ProviderError> {
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
		accountId: "pending",
	});
}

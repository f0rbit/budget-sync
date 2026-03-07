import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { getCurrentNetWorth, getNetWorthHistory } from "../services/networth-service.js";
import type { NetWorthBreakdown, NetWorthHistoryEntry } from "../services/networth-service.js";

function formatCurrency(amount: number): string {
	const abs = Math.abs(amount);
	const formatted = abs.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

function printBreakdownTable(breakdown: NetWorthBreakdown): void {
	console.log(`\nNet Worth: ${formatCurrency(breakdown.netWorth)}\n`);

	for (const account of breakdown.accounts) {
		const name = account.name.padEnd(22);
		const type = account.type.padEnd(14);
		const balance = formatCurrency(account.balance).padStart(12);
		console.log(`  ${name} ${type} ${balance}`);
	}

	console.log(`  ${"─".repeat(50)}`);
	console.log(`  ${"Total".padEnd(22)} ${"".padEnd(14)} ${formatCurrency(breakdown.netWorth).padStart(12)}`);
}

function printBreakdownCsv(breakdown: NetWorthBreakdown): void {
	console.log("account,type,balance");
	for (const account of breakdown.accounts) {
		const balance = account.balance.toFixed(2);
		console.log(`${account.name},${account.type},${balance}`);
	}
}

function printHistoryTable(history: NetWorthHistoryEntry[]): void {
	console.log(
		`${"Date".padEnd(13)}${" Net Worth".padStart(12)}${"Savings".padStart(14)}${"Transaction".padStart(14)}${"Credit".padStart(14)}`,
	);
	for (const entry of history) {
		const date = entry.date.padEnd(13);
		const nw = formatCurrency(entry.netWorth).padStart(12);
		const sav = formatCurrency(entry.savings).padStart(14);
		const txn = formatCurrency(entry.transaction).padStart(14);
		const cred = formatCurrency(entry.credit).padStart(14);
		console.log(`${date}${nw}${sav}${txn}${cred}`);
	}
}

function printHistoryCsv(history: NetWorthHistoryEntry[]): void {
	console.log("date,net_worth,savings,transaction,credit");
	for (const entry of history) {
		console.log(
			`${entry.date},${entry.netWorth.toFixed(2)},${entry.savings.toFixed(2)},${entry.transaction.toFixed(2)},${entry.credit.toFixed(2)}`,
		);
	}
}

const NO_DATA_MSG = "No snapshots found. Run 'budget-sync sync' or 'budget-sync snapshot' first.";

export const networthCommand = new Command("networth")
	.description("Show current net worth or net worth history")
	.option("--history", "Show net worth over time")
	.option("--from <date>", "Start date (YYYY-MM-DD) for history")
	.option("--to <date>", "End date (YYYY-MM-DD) for history")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		if (options.history) {
			const result = await getNetWorthHistory(db, { dateFrom: options.from, dateTo: options.to });
			if (!result.ok) {
				console.error(`Error: ${result.error.message}`);
				process.exit(1);
			}

			if (result.value.length === 0) {
				console.log(NO_DATA_MSG);
				return;
			}

			if (options.format === "json") return console.log(JSON.stringify(result.value, null, 2));
			if (options.format === "csv") return printHistoryCsv(result.value);
			return printHistoryTable(result.value);
		}

		const result = await getCurrentNetWorth(db);
		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		if (result.value.accounts.length === 0) {
			console.log(NO_DATA_MSG);
			return;
		}

		if (options.format === "json") return console.log(JSON.stringify(result.value, null, 2));
		if (options.format === "csv") return printBreakdownCsv(result.value);
		return printBreakdownTable(result.value);
	});

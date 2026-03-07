import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createCorpus } from "../corpus/client.js";
import type { AppContext } from "../db/client.js";
import { createDb } from "../db/client.js";
import { ManualSuperProvider } from "../providers/manual-super/provider.js";
import { getContributionSummary, getContributions } from "../services/contribution-service.js";
import type { ContributionRow } from "../services/contribution-service.js";
import { getLatestSnapshots } from "../services/snapshot-service.js";
import type { EnrichedSnapshot } from "../services/snapshot-service.js";
import { syncSuper } from "../services/super-sync-service.js";

function formatCurrency(amount: number): string {
	const abs = Math.abs(amount);
	const formatted = abs.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

function printBalanceTable(snapshots: EnrichedSnapshot[]): void {
	console.log(`\n${"Account".padEnd(30)} ${"Balance".padStart(14)} ${"Date".padStart(12)}`);
	console.log(`${"─".repeat(58)}`);
	for (const s of snapshots) {
		console.log(`${s.accountName.padEnd(30)} ${formatCurrency(s.balance).padStart(14)} ${s.date.padStart(12)}`);
	}
}

function printContributionsTable(rows: ContributionRow[]): void {
	console.log(`${"Date".padEnd(13)}${"Type".padEnd(19)}${"Amount".padStart(11)}  ${"Description"}`);
	console.log("─".repeat(65));
	for (const r of rows) {
		const date = r.date.padEnd(13);
		const type = r.type.padEnd(19);
		const amount = formatCurrency(r.amount).padStart(11);
		const desc = r.description ?? "";
		console.log(`${date}${type}${amount}  ${desc}`);
	}
}

function printContributionsCsv(rows: ContributionRow[]): void {
	console.log("date,type,amount,description");
	for (const r of rows) {
		console.log(`${r.date},${r.type},${r.amount.toFixed(2)},${r.description ?? ""}`);
	}
}

function printSummaryTable(summary: { type: string; total: number; count: number }[]): void {
	console.log(`${"Type".padEnd(19)}${"Total".padStart(14)}${"Count".padStart(8)}`);
	console.log("─".repeat(41));
	for (const row of summary) {
		console.log(`${row.type.padEnd(19)}${formatCurrency(row.total).padStart(14)}${String(row.count).padStart(8)}`);
	}
}

function printSummaryCsv(summary: { type: string; total: number; count: number }[]): void {
	console.log("type,total,count");
	for (const row of summary) {
		console.log(`${row.type},${row.total.toFixed(2)},${row.count}`);
	}
}

export const superCommand = new Command("super").description("Track superannuation balance and contributions");

superCommand
	.command("balance")
	.description("Show current super balance")
	.option("--format <type>", "Output format: table, json", "table")
	.action(async (options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const result = await getLatestSnapshots(db);
		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const superSnapshots = result.value.filter((s) => s.accountType === "super");
		if (superSnapshots.length === 0) {
			console.log("No super balance found. Run 'budget-sync super import <file>' first.");
			return;
		}

		if (options.format === "json") return console.log(JSON.stringify(superSnapshots, null, 2));
		return printBalanceTable(superSnapshots);
	});

superCommand
	.command("contributions")
	.description("Show super contributions")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--summary", "Show summary by type")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const filters = { dateFrom: options.from, dateTo: options.to };

		if (options.summary) {
			const result = await getContributionSummary(db, filters);
			if (!result.ok) {
				console.error(`Error: ${result.error.message}`);
				process.exit(1);
			}

			if (result.value.length === 0) {
				console.log("No contributions found.");
				return;
			}

			if (options.format === "json") return console.log(JSON.stringify(result.value, null, 2));
			if (options.format === "csv") return printSummaryCsv(result.value);
			return printSummaryTable(result.value);
		}

		const result = await getContributions(db, filters);
		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		if (result.value.length === 0) {
			console.log("No contributions found.");
			return;
		}

		if (options.format === "json") return console.log(JSON.stringify(result.value, null, 2));
		if (options.format === "csv") return printContributionsCsv(result.value);
		return printContributionsTable(result.value);
	});

superCommand
	.command("import")
	.description("Import super data from a JSON file")
	.argument("<file>", "Path to super data JSON file")
	.option("--account-name <name>", "Override account name")
	.option("--verbose", "Show detailed output")
	.action(async (file: string, options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const config = configResult.value;
		const db = createDb(config.db_path);
		const corpus = createCorpus(config.corpus_dir);

		const provider = new ManualSuperProvider({ filePath: file });
		const ctx: AppContext = { db, corpus };

		const result = await syncSuper(ctx, provider, {
			accountName: options.accountName,
			verbose: options.verbose,
		});

		if (!result.ok) {
			console.error(`Import failed: ${result.error.message}`);
			process.exit(1);
		}

		const s = result.value;
		console.log("\nSuper import complete:");
		console.log(`  Account:               ${s.accountName}`);
		console.log(`  Balance:               ${formatCurrency(s.balance)} (as of ${s.balanceDate})`);
		console.log(`  Contributions added:   ${s.contributionsInserted}`);
		console.log(`  Contributions skipped: ${s.contributionsSkipped}`);
	});

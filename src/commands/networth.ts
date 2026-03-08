import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { printBreakdownCsv, printBreakdownTable, printHistoryCsv, printHistoryTable } from "../formatters/networth.js";
import { getCurrentNetWorth, getNetWorthHistory } from "../services/networth-service.js";

const NO_DATA_MSG = "No snapshots found. Run 'budget-sync ingest' to import data.";

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

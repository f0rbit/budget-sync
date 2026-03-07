import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createCorpus } from "../corpus/client.js";
import { createDb } from "../db/client.js";
import { CsvBankProvider } from "../providers/csv/provider.js";
import { syncTransactions } from "../services/sync-service.js";

export const importCommand = new Command("import")
	.description("Import transactions from a CSV/JSON file")
	.argument("<file>", "Path to CSV or JSON file")
	.option("--account <name>", "Account name to associate with", "CSV Import")
	.option("--type <type>", "Account type (transaction, savings, credit)", "transaction")
	.option("--dry-run", "Preview without writing to DB")
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
		const ctx = { db, corpus };

		const provider = new CsvBankProvider({
			filePath: file,
			accountName: options.account,
			accountType: options.type as "transaction" | "savings" | "credit",
		});

		if (options.dryRun) {
			console.log("Dry run — no data will be written to DB.\n");
		}

		const result = await syncTransactions(ctx, provider, config, {
			dryRun: options.dryRun,
			verbose: options.verbose,
		});

		if (!result.ok) {
			console.error(`Import failed: ${result.error.message}`);
			process.exit(1);
		}

		console.log("Import complete:");
		console.log(`  Transactions created: ${result.value.transactionsCreated}`);
		console.log(`  Transactions excluded: ${result.value.transactionsExcluded}`);
		console.log(`  Duplicates skipped: ${result.value.transactionsSkipped}`);
		console.log(`  Duration: ${result.value.duration}ms`);
	});

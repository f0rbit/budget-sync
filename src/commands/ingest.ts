import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createCorpus } from "../corpus/client.js";
import { createDb } from "../db/client.js";
import { CsvBankProvider } from "../providers/csv/provider.js";
import { createDocumentParser } from "../providers/index.js";
import { ingestDocument } from "../services/ingest-service.js";
import { syncTransactions } from "../services/sync-service.js";

export const ingestCommand = new Command("ingest")
	.description("Parse a bank document (PDF, CSV, image) and import transactions")
	.argument("<file>", "Path to document")
	.option("--account <name>", "Account name (overrides AI inference)")
	.option("--account-type <type>", "Account type: transaction, savings, credit", "transaction")
	.option("--institution <name>", "Institution name (e.g., BankSA)")
	.option("--parser <type>", "Parser: ai (default), csv (fast path)")
	.option("--from <date>", "Only import transactions after this date (YYYY-MM-DD)")
	.option("--to <date>", "Only import transactions before this date (YYYY-MM-DD)")
	.option("--dry-run", "Preview without writing to DB")
	.option("--verbose", "Show detailed output")
	.option("--model <model>", "Override AI model")
	.action(async (file: string, options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			const e = configResult.error;
			if (e.code === "CONFIG_NOT_FOUND") {
				console.error(`Config file not found: ${e.path}`);
				console.error("Copy config.example.jsonc to config.jsonc and configure it.");
			} else {
				console.error(`Config error: ${e.message}`);
			}
			process.exit(1);
		}

		const config = configResult.value;

		// Override model if specified
		if (options.model) {
			config.anthropic.model = options.model;
		}

		const db = createDb(config.db_path);
		const corpus = createCorpus(config.corpus_dir);
		const ctx = { db, corpus };

		// CSV fast path
		if (options.parser === "csv" || (!options.parser && file.endsWith(".csv"))) {
			// Use existing CSV provider + sync service
			const provider = new CsvBankProvider({
				filePath: file,
				accountName: options.account ?? "CSV Import",
				accountType: options.accountType as "transaction" | "savings" | "credit",
			});

			if (options.dryRun) {
				console.log("Dry run — no data will be written to DB.\n");
			}

			const result = await syncTransactions(ctx, provider, config, {
				dateFrom: options.from,
				dateTo: options.to,
				dryRun: options.dryRun,
				verbose: options.verbose,
			});

			if (!result.ok) {
				console.error(`Import failed: ${result.error.message}`);
				process.exit(1);
			}

			console.log("CSV import complete:");
			console.log(`  Transactions created:   ${result.value.transactionsCreated}`);
			console.log(`  Transactions excluded:  ${result.value.transactionsExcluded}`);
			console.log(`  Duplicates skipped:     ${result.value.transactionsSkipped}`);
			console.log(`  Duration:               ${result.value.duration}ms`);
			return;
		}

		// AI parser path
		const parserResult = createDocumentParser(config);
		if (!parserResult.ok) {
			const pe = parserResult.error;
			console.error(`Parser error: ${pe.code === "CONFIG_NOT_FOUND" ? pe.path : pe.message}`);
			process.exit(1);
		}

		if (options.dryRun) {
			console.log("Dry run — corpus snapshots will be created but DB will not be modified.\n");
		}

		if (options.verbose) {
			console.log(`Parser:       ${parserResult.value.name}`);
			console.log(`Model:        ${config.anthropic.model}`);
			console.log(`File:         ${file}`);
			console.log(`Date range:   ${options.from ?? "(all)"} to ${options.to ?? "(all)"}`);
			console.log("");
		}

		const result = await ingestDocument(ctx, parserResult.value, file, config, {
			accountName: options.account,
			accountType: options.accountType,
			institution: options.institution,
			dateFrom: options.from,
			dateTo: options.to,
			dryRun: options.dryRun,
			verbose: options.verbose,
		});

		if (!result.ok) {
			console.error(`Ingest failed: ${result.error.message}`);
			process.exit(1);
		}

		const summary = result.value;
		console.log("Ingest complete:");
		console.log(`  Account:                ${summary.accountName}`);
		console.log(`  Transactions created:   ${summary.transactionsCreated}`);
		console.log(`  Transactions excluded:  ${summary.transactionsExcluded}`);
		console.log(`  Duplicates skipped:     ${summary.transactionsSkipped}`);
		console.log(`  Balance snapshots:      ${summary.snapshotsUpserted}`);
		if (summary.netWorth !== undefined) {
			console.log(`  Current net worth:      $${summary.netWorth.toLocaleString()}`);
		}
		console.log(`  Duration:               ${summary.duration}ms`);
		console.log(`  Status:                 ${summary.status}`);

		if (summary.notes.length > 0) {
			console.log("\nNotes from parser:");
			for (const note of summary.notes) {
				console.log(`  - ${note}`);
			}
		}
	});

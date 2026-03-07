import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createCorpus } from "../corpus/client.js";
import { createDb } from "../db/client.js";
import { createProvider } from "../providers/index.js";
import { syncTransactions } from "../services/sync-service.js";

export const syncCommand = new Command("sync")
	.description("Fetch transactions from provider, categorize, and store in DB")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--dry-run", "Preview without writing to DB")
	.option("--provider <name>", "Override provider (basiq, csv, manual)")
	.option("--account <id>", "Sync specific account only")
	.option("--verbose", "Show detailed output")
	.action(async (options) => {
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

		if (options.provider) {
			const validProviders = ["basiq", "csv", "manual"] as const;
			const matched = validProviders.find((p) => p === options.provider);
			if (!matched) {
				console.error(`Invalid provider: ${options.provider}. Must be one of: ${validProviders.join(", ")}`);
				process.exit(1);
			}
			config.provider = matched;
		}

		const db = createDb(config.db_path);
		const corpus = createCorpus(config.corpus_dir);
		const ctx = { db, corpus };

		const providerResult = createProvider(config);
		if (!providerResult.ok) {
			const e = providerResult.error;
			console.error(`Provider error: ${e.code === "CONFIG_NOT_FOUND" ? e.path : e.message}`);
			process.exit(1);
		}

		if (options.dryRun) {
			console.log("Dry run — corpus snapshots will be created but DB will not be modified.\n");
		}

		if (options.verbose) {
			console.log(`Provider: ${providerResult.value.name}`);
			console.log(`Date range: ${options.from ?? "(default)"} to ${options.to ?? "(today)"}`);
			console.log("");
		}

		const result = await syncTransactions(ctx, providerResult.value, config, {
			dateFrom: options.from,
			dateTo: options.to,
			dryRun: options.dryRun,
			accountId: options.account,
			verbose: options.verbose,
		});

		if (!result.ok) {
			console.error(`Sync failed: ${result.error.message}`);
			process.exit(1);
		}

		const summary = result.value;
		console.log("Sync complete:");
		console.log(`  Accounts synced:        ${summary.accountsSynced}`);
		console.log(`  Transactions created:   ${summary.transactionsCreated}`);
		console.log(`  Transactions excluded:  ${summary.transactionsExcluded}`);
		console.log(`  Duplicates skipped:     ${summary.transactionsSkipped}`);
		console.log(`  Corpus snapshots:       ${summary.snapshotsCreated}`);
		console.log(`  Duration:               ${summary.duration}ms`);
		console.log(`  Status:                 ${summary.status}`);
	});

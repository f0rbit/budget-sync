import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createCorpus } from "../corpus/client.js";
import { createDb } from "../db/client.js";
import { CsvDocumentParser } from "../providers/csv/document-parser.js";
import { createAiCategorizer, createDocumentParser } from "../providers/index.js";
import type { DocumentParser } from "../providers/types.js";
import { ingestDocument } from "../services/ingest-service.js";

export const ingestCommand = new Command("ingest")
	.description("Parse a bank document (PDF, CSV, image) and import transactions")
	.argument("<file>", "Path to document")
	.option("--account <name>", "Account name (overrides AI inference)")
	.option("--account-type <type>", "Account type: transaction, savings, credit", "transaction")
	.option("--institution <name>", "Institution name (e.g., BankSA)")
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

		// Select parser based on file type
		let parser: DocumentParser;
		if (file.endsWith(".csv")) {
			parser = new CsvDocumentParser();
		} else {
			const parserResult = createDocumentParser(config);
			if (!parserResult.ok) {
				const pe = parserResult.error;
				console.error(`Parser error: ${pe.code === "CONFIG_NOT_FOUND" ? pe.path : pe.message}`);
				process.exit(1);
			}
			parser = parserResult.value;
		}

		// Create AI categorizer (optional — graceful if no API key)
		const catResult = createAiCategorizer(config);
		const aiCategorizer = catResult.ok ? catResult.value : undefined;

		if (options.dryRun) {
			console.log("Dry run — corpus snapshots will be created but DB will not be modified.\n");
		}

		if (options.verbose) {
			console.log(`Parser:       ${parser.name}`);
			console.log(`AI categorizer: ${aiCategorizer ? "enabled" : "disabled (no API key)"}`);
			console.log(`File:         ${file}`);
			console.log(`Date range:   ${options.from ?? "(all)"} to ${options.to ?? "(all)"}`);
			console.log("");
		}

		const result = await ingestDocument(ctx, parser, file, config, {
			accountName: options.account,
			accountType: options.accountType,
			institution: options.institution,
			dateFrom: options.from,
			dateTo: options.to,
			dryRun: options.dryRun,
			verbose: options.verbose,
			aiCategorizer,
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
			console.log("\nNotes:");
			for (const note of summary.notes) {
				console.log(`  - ${note}`);
			}
		}
	});

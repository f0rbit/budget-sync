import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { exportToObsidian } from "../services/export-service.js";

export const exportCommand = new Command("export")
	.description("Export transactions to Obsidian markdown notes")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--dry-run", "Preview without writing files")
	.option("--force", "Overwrite existing notes")
	.action(async (options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const config = configResult.value;
		const db = createDb(config.db_path);

		if (options.dryRun) {
			console.log("Dry run — no files will be written.\n");
		}

		const result = exportToObsidian(db, config.vault_path, config.budget_dir, {
			dateFrom: options.from,
			dateTo: options.to,
			dryRun: options.dryRun,
			force: options.force,
		});

		if (!result.ok) {
			const error = result.error;
			if (error.code === "VAULT_NOT_FOUND") {
				console.error(`Vault not found: ${error.path}`);
			} else {
				console.error(`Export failed: ${error.message}`);
			}
			process.exit(1);
		}

		console.log("Export complete:");
		console.log(`  Notes created: ${result.value.notesCreated}`);
		console.log(`  Notes skipped: ${result.value.notesSkipped}`);
		console.log(`  Output: ${result.value.outputDir}`);
	});

import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { deactivateAccount, listAccounts } from "../services/account-service.js";

export const accountsCommand = new Command("accounts").description("List and manage connected accounts");

accountsCommand
	.command("list")
	.description("List all active accounts")
	.action(async () => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(
				`Config error: ${configResult.error.code} — ${configResult.error.code === "CONFIG_NOT_FOUND" ? configResult.error.path : "message" in configResult.error ? configResult.error.message : ""}`,
			);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const result = await listAccounts(db);
		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		if (result.value.length === 0) {
			console.log("No accounts found. Run 'budget-sync ingest' to import accounts.");
			return;
		}

		console.log("\nAccounts:");
		console.log("─".repeat(80));
		for (const account of result.value) {
			console.log(
				`  ${account.id.slice(0, 8)}  ${account.name.padEnd(30)} ${account.type.padEnd(12)} ${account.institution ?? ""}`,
			);
		}
		console.log(`\n${result.value.length} account(s)`);
	});

accountsCommand
	.command("deactivate")
	.argument("<id>", "Account ID to deactivate")
	.description("Mark account as inactive (excluded from sync)")
	.action(async (id: string) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const result = await deactivateAccount(db, id);
		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		console.log(`Account ${id} deactivated.`);
	});

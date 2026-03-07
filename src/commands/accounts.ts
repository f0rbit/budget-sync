import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createProvider } from "../providers/index.js";
import { deactivateAccount, listAccounts, upsertAccount } from "../services/account-service.js";

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
			console.log("No accounts found. Run 'accounts discover' to find accounts.");
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
	.command("discover")
	.description("Fetch accounts from provider and add new ones to DB")
	.action(async () => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const config = configResult.value;
		const db = createDb(config.db_path);

		const providerResult = createProvider(config);
		if (!providerResult.ok) {
			const e = providerResult.error;
			console.error(`Provider error: ${"message" in e ? e.message : e.path}`);
			process.exit(1);
		}
		const provider = providerResult.value;

		const authResult = await provider.authenticate();
		if (!authResult.ok) {
			console.error(`Auth failed: ${authResult.error.message}`);
			process.exit(1);
		}

		const accountsResult = await provider.getAccounts();
		if (!accountsResult.ok) {
			console.error(`Fetch failed: ${accountsResult.error.message}`);
			process.exit(1);
		}

		for (const info of accountsResult.value) {
			await upsertAccount(db, provider.name, info);
		}

		console.log(`Discovered ${accountsResult.value.length} account(s). Synced to DB.`);
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

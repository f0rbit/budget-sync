import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { deactivateAccount, listAccounts, mergeAccounts } from "../services/account-service.js";

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

accountsCommand
	.command("merge")
	.argument("<from-id>", "Account ID to merge from (will be removed)")
	.argument("<into-id>", "Account ID to merge into (kept)")
	.option("--dry-run", "Preview the merge without writing")
	.description("Merge one account's transactions/snapshots/holdings/contributions into another, then remove it")
	.action(async (fromId: string, intoId: string, opts: { dryRun?: boolean }) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const result = await mergeAccounts(db, fromId, intoId, { dryRun: opts.dryRun });
		if (!result.ok) {
			if (result.error.code === "MERGE_CONFLICT") {
				console.error(`Merge aborted — ${result.error.message}`);
				for (const c of result.error.collisions) {
					console.error(
						c.table === "transactions" ? `  transactions: external_id ${c.externalId}` : `  snapshots: date ${c.date}`,
					);
				}
			} else {
				console.error(`Error: ${result.error.message}`);
			}
			process.exit(1);
		}

		const r = result.value;
		console.log(r.dryRun ? "Dry run — no changes written." : "Merge complete.");
		console.log(`  transactions:   ${r.transactionsMoved}`);
		console.log(`  snapshots:      ${r.snapshotsMoved}`);
		console.log(`  holdings:       ${r.holdingsMoved}`);
		console.log(`  contributions:  ${r.contributionsMoved}`);
		if (!r.dryRun) {
			console.log(`Account ${r.fromAccountId} merged into ${r.intoAccountId} and removed.`);
		}
	});

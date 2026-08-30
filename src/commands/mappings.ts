import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { loadMappings } from "../pipeline/local-mappings.js";
import { applyMappingsPlan, planMappingsApply } from "../services/mapping-apply-service.js";
import { getTransactions, getUncategorized } from "../services/transaction-service.js";

export const mappingsCommand = new Command("mappings").description("Manage merchant categorization mappings");

mappingsCommand
	.command("list")
	.description("List all merchant mappings")
	.action(() => {
		const result = loadMappings();
		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const { mappings, exclusions } = result.value;

		console.log("\nMerchant Mappings:");
		console.log("─".repeat(80));
		for (const m of mappings) {
			console.log(`  ${m.match.padEnd(30)} → ${m.item.padEnd(25)} [${m.category}]`);
		}
		console.log(`\n${mappings.length} mapping(s)`);

		if (exclusions.length > 0) {
			console.log("\nExclusion Rules:");
			console.log("─".repeat(80));
			for (const e of exclusions) {
				console.log(`  ${e.match.padEnd(30)} — ${e.reason}`);
			}
			console.log(`\n${exclusions.length} exclusion(s)`);
		}
	});

mappingsCommand
	.command("search")
	.argument("<query>", "Search query")
	.description("Search mappings by merchant name")
	.action((query: string) => {
		const result = loadMappings();
		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const upper = query.toUpperCase();
		const matches = result.value.mappings.filter(
			(m) => m.match.toUpperCase().includes(upper) || m.item.toUpperCase().includes(upper),
		);

		if (matches.length === 0) {
			console.log(`No mappings matching "${query}"`);
			return;
		}

		console.log(`\nMappings matching "${query}":`);
		for (const m of matches) {
			console.log(`  ${m.match.padEnd(30)} → ${m.item.padEnd(25)} [${m.category}]`);
		}
	});

mappingsCommand
	.command("unmapped")
	.description("List transactions categorized as 'Other' (need mapping)")
	.action(async () => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const result = await getUncategorized(db);
		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		if (result.value.length === 0) {
			console.log("No uncategorized transactions. All mapped!");
			return;
		}

		console.log("\nUncategorized Transactions:");
		console.log("─".repeat(80));
		for (const tx of result.value) {
			console.log(`  ${tx.date}  $${tx.amount.toFixed(2).padStart(8)}  ${tx.rawDescription}`);
		}
		console.log(`\n${result.value.length} transaction(s) need mapping`);
	});

mappingsCommand
	.command("apply")
	.description("Re-run local mappings + exclusion rules over existing transactions (no re-ingest)")
	.option("--dry-run", "Show what would change without writing to the database", false)
	.option("--force", "Recategorize even if current category isn't 'Other'", false)
	.action(async (options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const mappingsResult = loadMappings();
		if (!mappingsResult.ok) {
			console.error(`Error: ${mappingsResult.error.message}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const rowsResult = await getTransactions(db);
		if (!rowsResult.ok) {
			console.error(`Error: ${rowsResult.error.message}`);
			process.exit(1);
		}

		const { mappings, exclusions } = mappingsResult.value;
		const plan = planMappingsApply(rowsResult.value, mappings, exclusions, { force: options.force });

		const excludedChanges = plan.changes.filter((c) => c.type === "excluded");
		const recategorizedChanges = plan.changes.filter((c) => c.type === "recategorized");

		console.log(`Scanned ${plan.scanned} transaction(s)`);

		if (excludedChanges.length > 0) {
			console.log("\nTo be excluded:");
			for (const c of excludedChanges) {
				console.log(`  ${c.row.date}  $${c.row.amount.toFixed(2).padStart(8)}  ${c.row.rawDescription} — ${c.reason}`);
			}
		}

		if (recategorizedChanges.length > 0) {
			console.log("\nTo be recategorized:");
			for (const c of recategorizedChanges) {
				console.log(
					`  ${c.row.date}  $${c.row.amount.toFixed(2).padStart(8)}  ${c.row.rawDescription} — [${c.row.category} → ${c.category}] "${c.row.item}" → "${c.item}"`,
				);
			}
		}

		console.log(`\n${excludedChanges.length} excluded, ${recategorizedChanges.length} recategorized`);

		if (options.dryRun) {
			console.log("(dry run — no changes written)");
			return;
		}

		if (plan.changes.length === 0) {
			return;
		}

		const applyResult = await applyMappingsPlan(db, plan);
		if (!applyResult.ok) {
			console.error(`Error: ${applyResult.error.message}`);
			process.exit(1);
		}

		console.log("Applied.");
	});

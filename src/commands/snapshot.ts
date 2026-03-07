import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createCorpus } from "../corpus/client.js";
import type { RawBalancesSnapshot } from "../corpus/schemas.js";
import { createDb } from "../db/client.js";
import { createProvider } from "../providers/index.js";
import { materializeBalances } from "../services/snapshot-service.js";

export const snapshotCommand = new Command("snapshot")
	.description("Capture current account balances without full sync")
	.option("--provider <name>", "Override provider (basiq, csv, manual)")
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
			const validProviders = ["csv", "manual"] as const;
			const matched = validProviders.find((p) => p === options.provider);
			if (!matched) {
				console.error(`Invalid provider: ${options.provider}. Must be one of: ${validProviders.join(", ")}`);
				process.exit(1);
			}
			config.provider = matched;
		}

		const db = createDb(config.db_path);
		const corpus = createCorpus(config.corpus_dir);

		const providerResult = createProvider(config);
		if (!providerResult.ok) {
			const e = providerResult.error;
			console.error(`Provider error: ${e.code === "CONFIG_NOT_FOUND" ? e.path : e.message}`);
			process.exit(1);
		}

		const provider = providerResult.value;

		const authResult = await provider.authenticate();
		if (!authResult.ok) {
			console.error(`Authentication failed: ${authResult.error.message}`);
			process.exit(1);
		}

		const balancesResult = await provider.getAccountBalances();
		if (!balancesResult.ok) {
			console.error(`Failed to fetch balances: ${balancesResult.error.message}`);
			process.exit(1);
		}

		const today = new Date().toISOString().slice(0, 10);
		const balances = balancesResult.value;

		const balancesSnapshot: RawBalancesSnapshot = {
			provider: provider.name,
			fetchedAt: new Date().toISOString(),
			balances,
		};
		await corpus.stores["raw-balances"].put(balancesSnapshot, {
			tags: [`provider:${provider.name}`, `date:${today}`],
		});

		const matResult = await materializeBalances(db, provider.name, balances);
		const materialized = matResult.ok ? matResult.value : 0;

		console.log("Snapshot complete:");
		console.log(`  Provider:          ${provider.name}`);
		console.log(`  Balances captured: ${materialized}`);
		console.log(`  Date:              ${today}`);
	});

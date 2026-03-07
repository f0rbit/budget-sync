import { Command } from "commander";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { formatCurrency } from "../formatters/networth.js";
import { getCategorySummary, getTransactions, searchTransactions } from "../services/transaction-service.js";

const listCommand = new Command("list")
	.description("List transactions with optional filters")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--category <cat>", "Filter by category")
	.option("--account <id>", "Filter by account ID")
	.option("--limit <n>", "Max transactions to show", "50")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const result = await getTransactions(db, {
			dateFrom: options.from,
			dateTo: options.to,
			category: options.category,
			accountId: options.account,
			limit: options.limit ? Number.parseInt(options.limit, 10) : 50,
		});

		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const txns = result.value;

		if (txns.length === 0) {
			console.log("No transactions found.");
			return;
		}

		if (options.format === "json") {
			console.log(JSON.stringify(txns, null, 2));
			return;
		}

		if (options.format === "csv") {
			console.log("date,amount,category,item,description");
			for (const tx of txns) {
				console.log(`${tx.date},${tx.amount.toFixed(2)},${tx.category},"${tx.item}","${tx.rawDescription}"`);
			}
			return;
		}

		// Table format
		console.log(`${"Date".padEnd(13)}${"Amount".padStart(10)}  ${"Category".padEnd(16)}${"Item"}`);
		console.log("─".repeat(70));
		for (const tx of txns) {
			const date = tx.date.padEnd(13);
			const amount = formatCurrency(tx.amount).padStart(10);
			const category = tx.category.padEnd(16);
			console.log(`${date}${amount}  ${category}${tx.item}`);
		}

		const total = txns.reduce((sum, tx) => sum + tx.amount, 0);
		console.log("─".repeat(70));
		console.log(`${txns.length} transaction(s) | Total: ${formatCurrency(total)}`);
	});

const summaryCommand = new Command("summary")
	.description("Category breakdown of spending")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--account <id>", "Filter by account ID")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const result = await getCategorySummary(db, {
			dateFrom: options.from,
			dateTo: options.to,
			accountId: options.account,
		});

		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const rows = result.value;

		if (rows.length === 0) {
			console.log("No transactions found.");
			return;
		}

		if (options.format === "json") {
			console.log(JSON.stringify(rows, null, 2));
			return;
		}

		if (options.format === "csv") {
			console.log("category,total,count,percent");
			const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
			for (const r of rows) {
				const pct = grandTotal > 0 ? ((r.total / grandTotal) * 100).toFixed(1) : "0.0";
				console.log(`${r.category},${r.total.toFixed(2)},${r.count},${pct}`);
			}
			return;
		}

		// Table format
		const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
		const dateRange = [options.from, options.to].filter(Boolean).join(" to ") || "all time";
		console.log(`Category Breakdown (${dateRange})`);
		console.log("─".repeat(60));

		for (const r of rows) {
			const pct = grandTotal > 0 ? (r.total / grandTotal) * 100 : 0;
			const cat = r.category.padEnd(18);
			const total = formatCurrency(r.total).padStart(10);
			const count = `${r.count}`.padStart(4);
			const pctStr = `${pct.toFixed(0)}%`.padStart(5);
			const bar = "█".repeat(Math.round(pct / 3));
			console.log(`${cat}${total} ${count} txns ${pctStr}  ${bar}`);
		}

		console.log("─".repeat(60));
		console.log(`${"Total".padEnd(18)}${formatCurrency(grandTotal).padStart(10)}`);
	});

const searchCommand = new Command("search")
	.description("Search transactions by item or description")
	.argument("<query>", "Search query")
	.option("--limit <n>", "Max results", "20")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (query: string, options) => {
		const configResult = loadConfig();
		if (!configResult.ok) {
			console.error(`Config error: ${configResult.error.code}`);
			process.exit(1);
		}
		const db = createDb(configResult.value.db_path);

		const result = await searchTransactions(db, query, options.limit ? Number.parseInt(options.limit, 10) : 20);

		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const txns = result.value;

		if (txns.length === 0) {
			console.log(`No transactions matching "${query}".`);
			return;
		}

		if (options.format === "json") {
			console.log(JSON.stringify(txns, null, 2));
			return;
		}

		if (options.format === "csv") {
			console.log("date,amount,category,item,description");
			for (const tx of txns) {
				console.log(`${tx.date},${tx.amount.toFixed(2)},${tx.category},"${tx.item}","${tx.rawDescription}"`);
			}
			return;
		}

		// Table format
		console.log(`Search: "${query}"`);
		console.log(`${"Date".padEnd(13)}${"Amount".padStart(10)}  ${"Category".padEnd(16)}${"Item"}`);
		console.log("─".repeat(70));
		for (const tx of txns) {
			const date = tx.date.padEnd(13);
			const amount = formatCurrency(tx.amount).padStart(10);
			const category = tx.category.padEnd(16);
			console.log(`${date}${amount}  ${category}${tx.item}`);
		}
		console.log(`\n${txns.length} result(s)`);
	});

export const transactionsCommand = new Command("transactions")
	.description("View and search transactions")
	.addCommand(listCommand)
	.addCommand(summaryCommand)
	.addCommand(searchCommand);

import { Command } from "commander";
import { type AppConfig, loadConfig } from "../config.js";
import { type AppDatabase, createDb } from "../db/client.js";
import { formatCurrency } from "../formatters/networth.js";
import { CATEGORIES } from "../providers/types.js";
import { pivotMonthly } from "../reporting/monthly.js";
import { detectRecurring } from "../reporting/recurring.js";
import { summarizeTransactions } from "../reporting/summary.js";
import {
	getReportRows,
	getTransactions,
	searchTransactions,
	selectTransactions,
	updateTransactions,
} from "../services/transaction-service.js";

/** Loads config and opens the DB, or exits the process with an error message. */
function loadDb(): { db: AppDatabase; config: AppConfig } {
	const configResult = loadConfig();
	if (!configResult.ok) {
		console.error(`Config error: ${configResult.error.code}`);
		process.exit(1);
	}
	return { db: createDb(configResult.value.db_path), config: configResult.value };
}

function formatRate(rate: number | null): string {
	return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

const listCommand = new Command("list")
	.description("List transactions with optional filters")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--category <cat>", "Filter by category")
	.option("--account <id>", "Filter by account ID")
	.option("--limit <n>", "Max transactions to show", "50")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (options) => {
		const { db } = loadDb();

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
	.description("Category breakdown of spending, plus income/net/savings-rate")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--account <id>", "Filter by account ID")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (options) => {
		const { db } = loadDb();

		const result = await getReportRows(db, {
			dateFrom: options.from,
			dateTo: options.to,
			accountId: options.account,
		});

		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const summary = summarizeTransactions(result.value);

		if (result.value.length === 0) {
			console.log("No transactions found.");
			return;
		}

		if (options.format === "json") {
			console.log(JSON.stringify(summary, null, 2));
			return;
		}

		if (options.format === "csv") {
			console.log("category,total,count,percent");
			for (const r of summary.spendByCategory) {
				const pct = summary.spend > 0 ? ((r.total / summary.spend) * 100).toFixed(1) : "0.0";
				console.log(`${r.category},${r.total.toFixed(2)},${r.count},${pct}`);
			}
			console.log(`spend,${summary.spend.toFixed(2)}`);
			console.log(`refunds,${summary.refunds.toFixed(2)}`);
			console.log(`income,${summary.income.toFixed(2)}`);
			console.log(`net,${summary.net.toFixed(2)}`);
			console.log(`savings_rate,${summary.savingsRate ?? ""}`);
			return;
		}

		// Table format
		const dateRange = [options.from, options.to].filter(Boolean).join(" to ") || "all time";
		console.log(`Category Breakdown (${dateRange})`);
		console.log("─".repeat(60));

		for (const r of summary.spendByCategory) {
			const pct = summary.spend > 0 ? (r.total / summary.spend) * 100 : 0;
			const cat = r.category.padEnd(18);
			const total = formatCurrency(r.total).padStart(10);
			const count = `${r.count}`.padStart(4);
			const pctStr = `${pct.toFixed(0)}%`.padStart(5);
			const bar = "█".repeat(Math.round(pct / 3));
			console.log(`${cat}${total} ${count} txns ${pctStr}  ${bar}`);
		}

		console.log("─".repeat(60));
		console.log(`${"Spend".padEnd(18)}${formatCurrency(summary.spend).padStart(10)}`);
		console.log(`${"Refunds".padEnd(18)}${formatCurrency(summary.refunds).padStart(10)}`);
		console.log(`${"Income".padEnd(18)}${formatCurrency(summary.income).padStart(10)}`);
		console.log(`${"Net".padEnd(18)}${formatCurrency(summary.net).padStart(10)}`);
		console.log(`${"Savings rate".padEnd(18)}${formatRate(summary.savingsRate).padStart(10)}`);
	});

const monthlyCommand = new Command("monthly")
	.description("Month x category pivot: spend, income, net, savings rate")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--account <id>", "Filter by account ID")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (options) => {
		const { db } = loadDb();

		const result = await getReportRows(db, {
			dateFrom: options.from,
			dateTo: options.to,
			accountId: options.account,
		});

		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const pivot = pivotMonthly(result.value);

		if (pivot.months.length === 0) {
			console.log("No transactions found.");
			return;
		}

		if (options.format === "json") {
			console.log(JSON.stringify(pivot, null, 2));
			return;
		}

		const columns = [...pivot.categories, "Spend", "Income", "Net", "Rate"] as const;

		if (options.format === "csv") {
			console.log(["month", ...columns].join(","));
			for (const m of pivot.months) {
				const values = pivot.categories.map((c) => (m.byCategory[c] ?? 0).toFixed(2));
				console.log(
					[m.month, ...values, m.spend.toFixed(2), m.income.toFixed(2), m.net.toFixed(2), m.savingsRate ?? ""].join(
						",",
					),
				);
			}
			return;
		}

		// Table format
		console.log(`${"Month".padEnd(9)}${columns.map((c) => c.padStart(12)).join("")}`);
		console.log("─".repeat(9 + columns.length * 12));
		for (const m of pivot.months) {
			const values = pivot.categories.map((c) => formatCurrency(m.byCategory[c] ?? 0).padStart(12));
			console.log(
				`${m.month.padEnd(9)}${values.join("")}${formatCurrency(m.spend).padStart(12)}${formatCurrency(m.income).padStart(12)}${formatCurrency(m.net).padStart(12)}${formatRate(m.savingsRate).padStart(12)}`,
			);
		}
	});

const recurringCommand = new Command("recurring")
	.description("Detect recurring charges (subscriptions, bills) from spend history")
	.option("--min-months <n>", "Minimum distinct months a charge must span", "3")
	.option("--as-of <date>", "Reference date for lapsed detection (YYYY-MM-DD)", todayIso())
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (options) => {
		const { db } = loadDb();

		const result = await getReportRows(db);

		if (!result.ok) {
			console.error(`Error: ${result.error.message}`);
			process.exit(1);
		}

		const charges = detectRecurring(result.value, {
			minMonths: Number.parseInt(options.minMonths, 10),
			asOf: options.asOf,
		});

		if (charges.length === 0) {
			console.log("No recurring charges found.");
			return;
		}

		if (options.format === "json") {
			console.log(JSON.stringify(charges, null, 2));
			return;
		}

		if (options.format === "csv") {
			console.log("item,category,cadence,typical_amount,occurrences,first_seen,last_seen,possibly_lapsed");
			for (const c of charges) {
				console.log(
					`"${c.item}",${c.category},${c.cadence},${c.typicalAmount.toFixed(2)},${c.occurrences},${c.firstSeen},${c.lastSeen},${c.possiblyLapsed}`,
				);
			}
			return;
		}

		// Table format
		console.log(
			`${"Item".padEnd(24)}${"Category".padEnd(16)}${"Cadence".padEnd(13)}${"Typical".padStart(10)}  ${"Count".padStart(5)}  ${"First".padEnd(12)}${"Last".padEnd(12)}Lapsed?`,
		);
		console.log("─".repeat(110));
		for (const c of charges) {
			console.log(
				`${c.item.padEnd(24)}${c.category.padEnd(16)}${c.cadence.padEnd(13)}${formatCurrency(c.typicalAmount).padStart(10)}  ${`${c.occurrences}`.padStart(5)}  ${c.firstSeen.padEnd(12)}${c.lastSeen.padEnd(12)}${c.possiblyLapsed ? "yes" : ""}`,
			);
		}
	});

const searchCommand = new Command("search")
	.description("Search transactions by item or description")
	.argument("<query>", "Search query")
	.option("--limit <n>", "Max results", "20")
	.option("--format <type>", "Output format: table, csv, json", "table")
	.action(async (query: string, options) => {
		const { db } = loadDb();

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

const setCommand = new Command("set")
	.description("Update category/item/notes on transactions, selected by id or by --match/--from/--to")
	.argument("[ids...]", "Transaction id(s) to update")
	.option("--category <cat>", `New category (one of: ${CATEGORIES.join(", ")})`)
	.option("--item <name>", "New item name")
	.option("--notes <text>", "New notes")
	.option("--match <substring>", "Select transactions whose raw description contains this substring")
	.option("--from <date>", "Select transactions from this date (YYYY-MM-DD), alternative selector")
	.option("--to <date>", "Select transactions up to this date (YYYY-MM-DD), alternative selector")
	.action(async (ids: string[], options) => {
		if (!options.category && !options.item && !options.notes) {
			console.error("Error: at least one of --category, --item, --notes is required.");
			process.exit(1);
		}

		if (options.category && !CATEGORIES.includes(options.category)) {
			console.error(`Error: invalid category "${options.category}". Valid: ${CATEGORIES.join(", ")}`);
			process.exit(1);
		}

		const hasIdSelector = ids.length > 0;
		const hasFilterSelector = Boolean(options.match || options.from || options.to);

		if (!hasIdSelector && !hasFilterSelector) {
			console.error("Error: no selector given. Pass transaction id(s), or --match/--from/--to.");
			process.exit(1);
		}

		const { db } = loadDb();

		const selectResult = await selectTransactions(
			db,
			hasIdSelector ? { ids } : { match: options.match, dateFrom: options.from, dateTo: options.to },
		);
		if (!selectResult.ok) {
			console.error(`Error: ${selectResult.error.message}`);
			process.exit(1);
		}

		const before = selectResult.value;
		if (before.length === 0) {
			console.log("No transactions matched.");
			return;
		}

		const updateResult = await updateTransactions(
			db,
			before.map((tx) => tx.id),
			{ category: options.category, item: options.item, notes: options.notes },
		);
		if (!updateResult.ok) {
			console.error(`Error: ${updateResult.error.message}`);
			process.exit(1);
		}

		const beforeById = new Map(before.map((tx) => [tx.id, tx]));
		console.log(`Updated ${updateResult.value.length} transaction(s):\n`);
		for (const after of updateResult.value) {
			const prev = beforeById.get(after.id);
			console.log(`  ${after.date}  $${after.amount.toFixed(2).padStart(8)}  ${after.rawDescription}`);
			console.log(`    category: ${prev?.category} → ${after.category}`);
			console.log(`    item:     ${prev?.item} → ${after.item}`);
			console.log(`    notes:    ${JSON.stringify(prev?.notes ?? "")} → ${JSON.stringify(after.notes ?? "")}`);
		}
	});

export const transactionsCommand = new Command("transactions")
	.description("View and search transactions")
	.addCommand(listCommand)
	.addCommand(summaryCommand)
	.addCommand(monthlyCommand)
	.addCommand(recurringCommand)
	.addCommand(searchCommand)
	.addCommand(setCommand);

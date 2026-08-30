import { isSpendCategory } from "../providers/types.js";
import type { Category } from "../providers/types.js";
import type { ReportTransaction } from "./types.js";

export interface CategoryTotal {
	category: Category;
	total: number;
	count: number;
}

export interface TransactionSummary {
	spendByCategory: CategoryTotal[];
	spend: number;
	income: number;
	refunds: number;
	net: number;
	savingsRate: number | null;
}

export function summarizeTransactions(rows: readonly ReportTransaction[]): TransactionSummary {
	const totals = new Map<Category, { total: number; count: number }>();
	let spend = 0;
	let income = 0;
	let refunds = 0;

	for (const row of rows) {
		if (row.direction === "credit") {
			if (row.category === "Income") income += row.amount;
			else if (row.category === "Refund") refunds += row.amount;
			continue;
		}

		if (!isSpendCategory(row.category)) continue;
		spend += row.amount;

		const entry = totals.get(row.category) ?? { total: 0, count: 0 };
		entry.total += row.amount;
		entry.count += 1;
		totals.set(row.category, entry);
	}

	const spendByCategory = Array.from(totals.entries())
		.map(([category, { total, count }]) => ({ category, total, count }))
		.sort((a, b) => b.total - a.total);

	const net = income - spend + refunds;
	const savingsRate = income > 0 ? net / income : null;

	return { spendByCategory, spend, income, refunds, net, savingsRate };
}

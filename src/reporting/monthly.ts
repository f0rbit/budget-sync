import { CATEGORIES } from "../providers/types.js";
import type { Category } from "../providers/types.js";
import { summarizeTransactions } from "./summary.js";
import type { ReportTransaction } from "./types.js";

export interface MonthRow {
	month: string; // YYYY-MM
	byCategory: Partial<Record<Category, number>>;
	spend: number;
	income: number;
	refunds: number;
	net: number;
	savingsRate: number | null;
}

export interface MonthlyPivot {
	months: MonthRow[];
	categories: Category[];
}

function monthOf(date: string): string {
	return date.slice(0, 7);
}

export function pivotMonthly(rows: readonly ReportTransaction[]): MonthlyPivot {
	const byMonth = new Map<string, ReportTransaction[]>();
	for (const row of rows) {
		const month = monthOf(row.date);
		const group = byMonth.get(month) ?? [];
		group.push(row);
		byMonth.set(month, group);
	}

	const seenCategories = new Set<Category>();
	const months = Array.from(byMonth.keys())
		.sort()
		.map((month) => {
			const group = byMonth.get(month) ?? [];
			const summary = summarizeTransactions(group);

			const byCategory: Partial<Record<Category, number>> = {};
			for (const { category, total } of summary.spendByCategory) {
				byCategory[category] = total;
				seenCategories.add(category);
			}

			return {
				month,
				byCategory,
				spend: summary.spend,
				income: summary.income,
				refunds: summary.refunds,
				net: summary.net,
				savingsRate: summary.savingsRate,
			};
		});

	const categories = CATEGORIES.filter((category) => seenCategories.has(category));

	return { months, categories };
}

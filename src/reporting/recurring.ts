import { isSpendCategory } from "../providers/types.js";
import type { Category } from "../providers/types.js";
import type { ReportTransaction } from "./types.js";

export const CADENCES = ["weekly", "fortnightly", "monthly", "quarterly", "irregular"] as const;
export type Cadence = (typeof CADENCES)[number];

export interface RecurringCharge {
	item: string;
	category: Category;
	cadence: Cadence;
	typicalAmount: number;
	occurrences: number;
	firstSeen: string;
	lastSeen: string;
	possiblyLapsed: boolean;
}

export interface DetectRecurringOptions {
	minMonths: number;
	asOf: string;
}

/** Days used to judge "lapsed" for a cadence with a fixed period. */
const CADENCE_PERIOD_DAYS: Record<Exclude<Cadence, "irregular">, number> = {
	weekly: 7,
	fortnightly: 14,
	monthly: 30,
	quarterly: 91,
};

function daysBetween(dateA: string, dateB: string): number {
	const a = new Date(dateA);
	const b = new Date(dateB);
	return Math.abs(Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24)));
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		const lo = sorted[mid - 1] ?? 0;
		const hi = sorted[mid] ?? 0;
		return (lo + hi) / 2;
	}
	return sorted[mid] ?? 0;
}

function cadenceFromMedianGap(medianGapDays: number): Cadence {
	if (medianGapDays <= 10) return "weekly";
	if (medianGapDays <= 20) return "fortnightly";
	if (medianGapDays <= 45) return "monthly";
	if (medianGapDays <= 100) return "quarterly";
	return "irregular";
}

export function detectRecurring(
	rows: readonly ReportTransaction[],
	options: DetectRecurringOptions,
): RecurringCharge[] {
	const groups = new Map<string, ReportTransaction[]>();

	for (const row of rows) {
		if (row.direction !== "debit" || !isSpendCategory(row.category)) continue;
		const key = row.item.trim().toLowerCase();
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}

	const charges: RecurringCharge[] = [];

	for (const group of groups.values()) {
		const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
		const first = sorted[0];
		if (!first) continue;

		const distinctMonths = new Set(sorted.map((row) => row.date.slice(0, 7)));
		if (distinctMonths.size < options.minMonths) continue;

		const gaps: number[] = [];
		for (let i = 1; i < sorted.length; i++) {
			const prev = sorted[i - 1];
			const curr = sorted[i];
			if (prev && curr) gaps.push(daysBetween(prev.date, curr.date));
		}

		const medianGap = gaps.length > 0 ? median(gaps) : 0;
		const cadence = cadenceFromMedianGap(medianGap);
		const lastSeen = sorted[sorted.length - 1] ?? first;

		const periodDays = cadence === "irregular" ? medianGap : CADENCE_PERIOD_DAYS[cadence];
		const possiblyLapsed = daysBetween(options.asOf, lastSeen.date) > 1.5 * periodDays;

		charges.push({
			item: first.item,
			category: first.category,
			cadence,
			typicalAmount: median(sorted.map((row) => row.amount)),
			occurrences: sorted.length,
			firstSeen: first.date,
			lastSeen: lastSeen.date,
			possiblyLapsed,
		});
	}

	return charges.sort((a, b) => b.typicalAmount - a.typicalAmount);
}

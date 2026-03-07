import { type Result, err, ok } from "@f0rbit/corpus";
import type { ExcludedTransaction, ExclusionRule, RawTransaction } from "../providers/types.js";

export type FilterResult = Result<RawTransaction, ExcludedTransaction>;

export function filterTransaction(tx: RawTransaction, exclusions: ExclusionRule[]): FilterResult {
	if (tx.direction === "credit") {
		return err({
			externalId: tx.id,
			rawDescription: tx.description,
			amount: tx.amount,
			direction: tx.direction,
			reason: "Credit transaction (incoming money)",
		});
	}

	for (const rule of exclusions) {
		const regex = new RegExp(rule.match, "i");
		if (regex.test(tx.description)) {
			return err({
				externalId: tx.id,
				rawDescription: tx.description,
				amount: tx.amount,
				direction: tx.direction,
				reason: rule.reason,
			});
		}
	}

	return ok(tx);
}

export function filterTransactions(
	transactions: RawTransaction[],
	exclusions: ExclusionRule[],
): { passed: RawTransaction[]; excluded: ExcludedTransaction[] } {
	const passed: RawTransaction[] = [];
	const excluded: ExcludedTransaction[] = [];

	for (const tx of transactions) {
		const result = filterTransaction(tx, exclusions);
		if (result.ok) {
			passed.push(result.value);
		} else {
			excluded.push(result.error);
		}
	}

	return { passed, excluded };
}

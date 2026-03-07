import type { AccountType, CategorizedTransaction, ExcludedTransaction } from "../providers/types.js";
import type { DedupCandidate } from "../services/transaction-service.js";

export type { DedupCandidate };

export interface DedupResult {
	kept: CategorizedTransaction[];
	duplicates: ExcludedTransaction[];
}

/** Maximum days between transaction dates to consider a cross-account match */
export const MAX_DAY_GAP = 5;

const ACCOUNT_TYPE_PRIORITY: Record<AccountType, number> = {
	credit: 3,
	transaction: 2,
	savings: 1,
	super: 0,
	investment: 0,
};

function daysBetween(dateA: string, dateB: string): number {
	const a = new Date(dateA);
	const b = new Date(dateB);
	return Math.abs(Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24)));
}

function findClosestMatch(tx: CategorizedTransaction, candidates: DedupCandidate[]): DedupCandidate | undefined {
	const txItem = tx.item.toLowerCase();

	const matches = candidates.filter(
		(c) =>
			c.amount === tx.amount &&
			c.item.toLowerCase() === txItem &&
			c.accountId !== tx.accountId &&
			!c.excluded &&
			daysBetween(tx.date, c.date) <= MAX_DAY_GAP,
	);

	if (matches.length === 0) return undefined;

	return matches.reduce((closest, c) =>
		daysBetween(tx.date, c.date) < daysBetween(tx.date, closest.date) ? c : closest,
	);
}

export function detectCrossAccountDuplicates(
	incoming: CategorizedTransaction[],
	existing: DedupCandidate[],
	incomingAccountType: AccountType,
): DedupResult {
	const kept: CategorizedTransaction[] = [];
	const duplicates: ExcludedTransaction[] = [];

	for (const tx of incoming) {
		if (tx.direction !== "debit" || tx.excluded) {
			kept.push(tx);
			continue;
		}

		const match = findClosestMatch(tx, existing);

		if (!match) {
			kept.push(tx);
			continue;
		}

		const incomingPriority = ACCOUNT_TYPE_PRIORITY[incomingAccountType];
		const existingPriority = ACCOUNT_TYPE_PRIORITY[match.accountType];

		if (incomingPriority <= existingPriority) {
			duplicates.push({
				externalId: tx.externalId,
				rawDescription: tx.rawDescription,
				amount: tx.amount,
				direction: tx.direction,
				reason: `Cross-account duplicate (matches ${match.accountType} account, ${match.date})`,
			});
		} else {
			kept.push(tx);
		}
	}

	return { kept, duplicates };
}

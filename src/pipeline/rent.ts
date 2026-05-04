import type { RentConfig } from "../config.js";
import type { CategorizedTransaction, RawTransaction } from "../providers/types.js";

export function isRentTransaction(tx: RawTransaction, config: RentConfig): boolean {
	for (const pattern of config.landlord_patterns) {
		if (tx.description.toUpperCase().includes(pattern.toUpperCase())) {
			return true;
		}
	}

	for (const pattern of config.debit_rent_patterns) {
		const regex = new RegExp(pattern, "i");
		if (regex.test(tx.description)) {
			return true;
		}
	}

	return false;
}

export function calculateRentAmount(tx: RawTransaction, config: RentConfig): number {
	const tx_date = new Date(tx.transactionDate);
	const solo_date = new Date(config.solo_start_date);

	if (tx_date >= solo_date) {
		return config.solo_weekly_amount;
	}

	return tx.amount - config.shared_roommate_contribution;
}

export function handleRent(tx: RawTransaction, config: RentConfig): CategorizedTransaction {
	const amount = calculateRentAmount(tx, config);
	const tx_date = new Date(tx.transactionDate);
	const solo_date = new Date(config.solo_start_date);
	const is_solo = tx_date >= solo_date;

	return {
		externalId: tx.id,
		date: tx.transactionDate,
		postDate: tx.postDate,
		rawDescription: tx.description,
		item: "Rent",
		amount,
		direction: tx.direction,
		category: "Rent",
		notes: is_solo
			? `Solo rent: $${config.solo_weekly_amount}/week`
			: config.shared_roommate_contribution === 0
				? `Solo rent: $${tx.amount}`
				: `Shared rent: $${tx.amount} - $${config.shared_roommate_contribution} roommate contribution`,
		excluded: false,
		accountId: tx.accountId,
	};
}

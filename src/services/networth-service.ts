import { type Result, ok } from "@f0rbit/corpus";
import type { AppDatabase } from "../db/client.js";
import type { DbError } from "../errors.js";
import type { AccountType } from "../providers/types.js";
import { type EnrichedSnapshot, getLatestSnapshots, getSnapshotHistory } from "./snapshot-service.js";

const INCLUDED_TYPES: ReadonlySet<string> = new Set(["transaction", "savings", "credit", "super"]);

export interface NetWorthBreakdown {
	date: string;
	netWorth: number;
	components: {
		transaction: number;
		savings: number;
		credit: number;
		super: number;
	};
	accounts: {
		id: string;
		name: string;
		type: AccountType;
		balance: number;
	}[];
}

export interface NetWorthHistoryEntry {
	date: string;
	netWorth: number;
	transaction: number;
	savings: number;
	credit: number;
	super: number;
}

interface AccountState {
	balance: number;
	type: AccountType;
}

function computeNetWorth(balances: Map<string, AccountState>): {
	transaction: number;
	savings: number;
	credit: number;
	super: number;
	netWorth: number;
} {
	let transaction = 0;
	let savings = 0;
	let credit = 0;
	let superBal = 0;

	for (const state of balances.values()) {
		if (!INCLUDED_TYPES.has(state.type)) continue;
		if (state.type === "transaction") transaction += state.balance;
		else if (state.type === "savings") savings += state.balance;
		else if (state.type === "credit") credit += state.balance;
		else if (state.type === "super") superBal += state.balance;
	}

	return { transaction, savings, credit, super: superBal, netWorth: transaction + savings + superBal - credit };
}

function todayString(): string {
	return new Date().toISOString().slice(0, 10);
}

const ZERO_BREAKDOWN: NetWorthBreakdown = {
	date: "",
	netWorth: 0,
	components: { transaction: 0, savings: 0, credit: 0, super: 0 },
	accounts: [],
};

export async function getCurrentNetWorth(db: AppDatabase): Promise<Result<NetWorthBreakdown, DbError>> {
	const result = await getLatestSnapshots(db);
	if (!result.ok) return result;

	const snapshots = result.value;
	if (snapshots.length === 0) {
		return ok({ ...ZERO_BREAKDOWN, date: todayString() });
	}

	const relevant = snapshots.filter((s) => INCLUDED_TYPES.has(s.accountType));

	const balances = new Map<string, AccountState>(
		relevant.map((s) => [s.accountId, { balance: s.balance, type: s.accountType }]),
	);

	const { transaction, savings, credit, netWorth, super: superBal } = computeNetWorth(balances);

	return ok({
		date: todayString(),
		netWorth,
		components: { transaction, savings, credit, super: superBal },
		accounts: relevant.map((s) => ({
			id: s.accountId,
			name: s.accountName,
			type: s.accountType,
			balance: s.balance,
		})),
	});
}

export async function getNetWorthHistory(
	db: AppDatabase,
	filters?: { dateFrom?: string; dateTo?: string },
): Promise<Result<NetWorthHistoryEntry[], DbError>> {
	const result = await getSnapshotHistory(db, filters);
	if (!result.ok) return result;

	const snapshots = result.value;
	if (snapshots.length === 0) return ok([]);

	const relevant = snapshots.filter((s) => INCLUDED_TYPES.has(s.accountType));

	const dates = [...new Set(relevant.map((s) => s.date))].sort();

	const snapshotsByDate = new Map<string, EnrichedSnapshot[]>();
	for (const s of relevant) {
		const group = snapshotsByDate.get(s.date);
		if (group) group.push(s);
		else snapshotsByDate.set(s.date, [s]);
	}

	const running = new Map<string, AccountState>();

	return ok(
		dates.map((date) => {
			const daySnapshots = snapshotsByDate.get(date) ?? [];
			for (const s of daySnapshots) {
				running.set(s.accountId, { balance: s.balance, type: s.accountType });
			}

			const { transaction, savings, credit, netWorth, super: superBal } = computeNetWorth(running);
			return { date, netWorth, transaction, savings, credit, super: superBal };
		}),
	);
}

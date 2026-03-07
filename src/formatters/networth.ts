import type { NetWorthBreakdown, NetWorthHistoryEntry } from "../services/networth-service.js";

export function formatCurrency(amount: number): string {
	const abs = Math.abs(amount);
	const formatted = abs.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

export function printBreakdownTable(breakdown: NetWorthBreakdown): void {
	console.log(`\nNet Worth: ${formatCurrency(breakdown.netWorth)}\n`);

	for (const account of breakdown.accounts) {
		const name = account.name.padEnd(22);
		const type = account.type.padEnd(14);
		const balance = formatCurrency(account.balance).padStart(12);
		console.log(`  ${name} ${type} ${balance}`);
	}

	console.log(`  ${"─".repeat(50)}`);
	console.log(`  ${"Total".padEnd(22)} ${"".padEnd(14)} ${formatCurrency(breakdown.netWorth).padStart(12)}`);
}

export function printBreakdownCsv(breakdown: NetWorthBreakdown): void {
	console.log("account,type,balance");
	for (const account of breakdown.accounts) {
		const balance = account.balance.toFixed(2);
		console.log(`${account.name},${account.type},${balance}`);
	}
}

export function printHistoryTable(history: NetWorthHistoryEntry[]): void {
	console.log(
		`${"Date".padEnd(13)}${" Net Worth".padStart(12)}${"Savings".padStart(14)}${"Super".padStart(14)}${"Transaction".padStart(14)}${"Credit".padStart(14)}`,
	);
	for (const entry of history) {
		const date = entry.date.padEnd(13);
		const nw = formatCurrency(entry.netWorth).padStart(12);
		const sav = formatCurrency(entry.savings).padStart(14);
		const sup = formatCurrency(entry.super).padStart(14);
		const txn = formatCurrency(entry.transaction).padStart(14);
		const cred = formatCurrency(entry.credit).padStart(14);
		console.log(`${date}${nw}${sav}${sup}${txn}${cred}`);
	}
}

export function printHistoryCsv(history: NetWorthHistoryEntry[]): void {
	console.log("date,net_worth,savings,super,transaction,credit");
	for (const entry of history) {
		console.log(
			`${entry.date},${entry.netWorth.toFixed(2)},${entry.savings.toFixed(2)},${entry.super.toFixed(2)},${entry.transaction.toFixed(2)},${entry.credit.toFixed(2)}`,
		);
	}
}

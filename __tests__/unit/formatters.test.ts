import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	formatCurrency,
	printBreakdownCsv,
	printBreakdownTable,
	printHistoryCsv,
	printHistoryTable,
} from "../../src/formatters/networth.js";
import type { NetWorthBreakdown, NetWorthHistoryEntry } from "../../src/services/networth-service.js";

let logSpy: ReturnType<typeof spyOn>;
let logOutput: string[];

beforeEach(() => {
	logOutput = [];
	logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logOutput.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	logSpy.mockRestore();
});

describe("formatCurrency", () => {
	it("formats positive amount", () => {
		expect(formatCurrency(1234.56)).toBe("$1,234.56");
	});

	it("formats negative amount", () => {
		expect(formatCurrency(-500)).toBe("-$500.00");
	});

	it("formats zero", () => {
		expect(formatCurrency(0)).toBe("$0.00");
	});

	it("formats large amount with commas", () => {
		expect(formatCurrency(1000000)).toBe("$1,000,000.00");
	});

	it("formats small decimal amount", () => {
		expect(formatCurrency(0.5)).toBe("$0.50");
	});
});

const breakdown: NetWorthBreakdown = {
	date: "2026-03-01",
	netWorth: 15000,
	components: { transaction: 5000, savings: 8000, credit: -1000, super: 3000 },
	accounts: [
		{ id: "acc1", name: "Everyday Account", type: "transaction", balance: 5000 },
		{ id: "acc2", name: "High Saver", type: "savings", balance: 8000 },
	],
};

describe("printBreakdownTable", () => {
	it("prints net worth header, account rows, separator, and total", () => {
		printBreakdownTable(breakdown);

		expect(logOutput.length).toBe(5);
		expect(logOutput[0]).toContain("Net Worth: $15,000.00");
		expect(logOutput[1]).toContain("Everyday Account");
		expect(logOutput[1]).toContain("transaction");
		expect(logOutput[1]).toContain("$5,000.00");
		expect(logOutput[2]).toContain("High Saver");
		expect(logOutput[2]).toContain("savings");
		expect(logOutput[2]).toContain("$8,000.00");
		expect(logOutput[3]).toContain("─");
		expect(logOutput[4]).toContain("Total");
		expect(logOutput[4]).toContain("$15,000.00");
	});
});

describe("printBreakdownCsv", () => {
	it("prints CSV header and data rows with 2-decimal balances", () => {
		printBreakdownCsv(breakdown);

		expect(logOutput[0]).toBe("account,type,balance");
		expect(logOutput[1]).toBe("Everyday Account,transaction,5000.00");
		expect(logOutput[2]).toBe("High Saver,savings,8000.00");
		expect(logOutput.length).toBe(3);
	});
});

const history: NetWorthHistoryEntry[] = [
	{ date: "2026-01-01", netWorth: 10000, transaction: 3000, savings: 6000, credit: -500, super: 1500 },
	{ date: "2026-02-01", netWorth: 12000, transaction: 3500, savings: 7000, credit: -1000, super: 2500 },
];

describe("printHistoryTable", () => {
	it("prints header with column names and formatted currency rows", () => {
		printHistoryTable(history);

		expect(logOutput.length).toBe(3);
		expect(logOutput[0]).toContain("Date");
		expect(logOutput[0]).toContain("Net Worth");
		expect(logOutput[0]).toContain("Savings");
		expect(logOutput[0]).toContain("Super");
		expect(logOutput[0]).toContain("Transaction");
		expect(logOutput[0]).toContain("Credit");
		expect(logOutput[1]).toContain("2026-01-01");
		expect(logOutput[1]).toContain("$10,000.00");
		expect(logOutput[1]).toContain("$6,000.00");
		expect(logOutput[1]).toContain("-$500.00");
		expect(logOutput[2]).toContain("2026-02-01");
		expect(logOutput[2]).toContain("$12,000.00");
	});
});

describe("printHistoryCsv", () => {
	it("prints CSV header and data rows with 2-decimal amounts", () => {
		printHistoryCsv(history);

		expect(logOutput[0]).toBe("date,net_worth,savings,super,transaction,credit");
		expect(logOutput[1]).toBe("2026-01-01,10000.00,6000.00,1500.00,3000.00,-500.00");
		expect(logOutput[2]).toBe("2026-02-01,12000.00,7000.00,2500.00,3500.00,-1000.00");
		expect(logOutput.length).toBe(3);
	});
});

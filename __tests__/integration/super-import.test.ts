import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../../src/db/client.js";
import { accounts, contributions, snapshots } from "../../src/db/schema.js";
import { InMemorySuperProvider } from "../../src/providers/in-memory/super-provider.js";
import { ManualSuperProvider } from "../../src/providers/manual-super/provider.js";
import { upsertAccount } from "../../src/services/account-service.js";
import {
	getContributionSummary,
	getContributions,
	insertContributions,
} from "../../src/services/contribution-service.js";
import { syncSuper } from "../../src/services/super-sync-service.js";
import {
	createTestContext,
	createTestSuperProvider,
	makeAccount,
	makeContribution,
	makeSuperBalance,
} from "../helpers.js";

function writeTempJson(data: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "super-test-"));
	const filePath = join(dir, "super.json");
	writeFileSync(filePath, JSON.stringify(data));
	return filePath;
}

describe("super-import", () => {
	let ctx: AppContext;

	beforeEach(() => {
		ctx = createTestContext();
	});

	// --- ManualSuperProvider ---

	it("S1: parses valid JSON file", async () => {
		const filePath = writeTempJson({
			balance: { amount: 85000, asOf: "2026-03-01" },
			contributions: [{ date: "2026-02-28", type: "employer", amount: 1200 }],
		});

		const provider = new ManualSuperProvider({ filePath });
		const authResult = await provider.authenticate();
		expect(authResult.ok).toBe(true);

		const balanceResult = await provider.getBalance();
		expect(balanceResult.ok).toBe(true);
		if (!balanceResult.ok) return;
		expect(balanceResult.value.balance).toBe(85000);
		expect(balanceResult.value.asOf).toBe("2026-03-01");

		const contribResult = await provider.getContributions({ from: "2026-01-01", to: "2026-12-31" });
		expect(contribResult.ok).toBe(true);
		if (!contribResult.ok) return;
		expect(contribResult.value.length).toBe(1);
	});

	it("S2: rejects invalid JSON with PARSE_ERROR", async () => {
		const filePath = writeTempJson({ invalid: true });
		const provider = new ManualSuperProvider({ filePath });
		const result = await provider.authenticate();

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PARSE_ERROR");
	});

	it("S3: filters contributions by date range", async () => {
		const filePath = writeTempJson({
			balance: { amount: 85000, asOf: "2026-03-01" },
			contributions: [
				{ date: "2026-01-15", type: "employer", amount: 1200 },
				{ date: "2026-02-15", type: "employer", amount: 1200 },
				{ date: "2026-03-15", type: "employer", amount: 1200 },
			],
		});

		const provider = new ManualSuperProvider({ filePath });
		await provider.authenticate();

		const result = await provider.getContributions({ from: "2026-02-01", to: "2026-02-28" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.length).toBe(1);
		expect(result.value[0]?.date).toBe("2026-02-15");
	});

	// --- InMemorySuperProvider ---

	it("S4: auth + balance + contributions round-trip", async () => {
		const provider = createTestSuperProvider({
			balance: makeSuperBalance(),
			contributions: [makeContribution()],
		});

		const authResult = await provider.authenticate();
		expect(authResult.ok).toBe(true);

		const balanceResult = await provider.getBalance();
		expect(balanceResult.ok).toBe(true);
		if (!balanceResult.ok) return;
		expect(balanceResult.value.balance).toBe(85000);

		const contribResult = await provider.getContributions({ from: "2026-01-01", to: "2026-12-31" });
		expect(contribResult.ok).toBe(true);
		if (!contribResult.ok) return;
		expect(contribResult.value.length).toBe(1);
	});

	it("S5: fail flags produce API_ERROR", async () => {
		const provider = createTestSuperProvider({ balance: makeSuperBalance() });
		provider.failNextBalance = true;

		const authResult = await provider.authenticate();
		expect(authResult.ok).toBe(true);

		const balanceResult = await provider.getBalance();
		expect(balanceResult.ok).toBe(false);
		if (balanceResult.ok) return;
		expect(balanceResult.error.code).toBe("API_ERROR");
	});

	// --- syncSuper full flow ---

	it("S6: full sync creates account, snapshot, and contributions", async () => {
		const provider = createTestSuperProvider({
			balance: makeSuperBalance({ balance: 90000, asOf: "2026-03-01" }),
			contributions: [
				makeContribution({ date: "2026-02-01", type: "employer", amount: 1200 }),
				makeContribution({ date: "2026-02-15", type: "salary_sacrifice", amount: 500 }),
			],
		});

		const result = await syncSuper(ctx, provider);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.balance).toBe(90000);
		expect(result.value.contributionsInserted).toBe(2);

		const dbAccounts = ctx.db.select().from(accounts).all();
		expect(dbAccounts.length).toBe(1);
		expect(dbAccounts[0]?.type).toBe("super");

		const dbSnapshots = ctx.db.select().from(snapshots).all();
		expect(dbSnapshots.length).toBe(1);

		const dbContribs = ctx.db.select().from(contributions).all();
		expect(dbContribs.length).toBe(2);
	});

	it("S7: re-import deduplicates contributions", async () => {
		const contribs = [
			makeContribution({ date: "2026-02-01", type: "employer", amount: 1200 }),
			makeContribution({ date: "2026-02-15", type: "salary_sacrifice", amount: 500 }),
		];

		const provider1 = createTestSuperProvider({
			balance: makeSuperBalance(),
			contributions: contribs,
		});
		const result1 = await syncSuper(ctx, provider1);
		expect(result1.ok).toBe(true);
		if (!result1.ok) return;
		expect(result1.value.contributionsInserted).toBe(2);

		const provider2 = createTestSuperProvider({
			balance: makeSuperBalance(),
			contributions: contribs,
		});
		const result2 = await syncSuper(ctx, provider2);
		expect(result2.ok).toBe(true);
		if (!result2.ok) return;
		expect(result2.value.contributionsInserted).toBe(0);
		expect(result2.value.contributionsSkipped).toBe(2);
	});

	// --- contribution-service direct ---

	it("S8: insertContributions deduplicates on re-insert", async () => {
		const acctResult = await upsertAccount(ctx.db, "test", makeAccount({ id: "ext-super", type: "super" }));
		expect(acctResult.ok).toBe(true);
		if (!acctResult.ok) return;
		const accountId = acctResult.value.id;

		const items = [{ date: "2026-03-01", type: "employer" as const, amount: 1200 }];

		const r1 = await insertContributions(ctx.db, accountId, items);
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		expect(r1.value.inserted).toBe(1);

		const r2 = await insertContributions(ctx.db, accountId, items);
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		expect(r2.value.inserted).toBe(0);
		expect(r2.value.skipped).toBe(1);

		const rows = ctx.db.select().from(contributions).all();
		expect(rows.length).toBe(1);
	});

	it("S9: getContributions filters by date range", async () => {
		const acctResult = await upsertAccount(ctx.db, "test", makeAccount({ id: "ext-super", type: "super" }));
		expect(acctResult.ok).toBe(true);
		if (!acctResult.ok) return;
		const accountId = acctResult.value.id;

		await insertContributions(ctx.db, accountId, [
			{ date: "2026-01-15", type: "employer" as const, amount: 1200 },
			{ date: "2026-02-15", type: "employer" as const, amount: 1200 },
			{ date: "2026-03-15", type: "employer" as const, amount: 1200 },
		]);

		const result = await getContributions(ctx.db, { dateFrom: "2026-02-01", dateTo: "2026-02-28" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.length).toBe(1);
		expect(result.value[0]?.date).toBe("2026-02-15");
	});

	it("S10: getContributionSummary aggregates by type", async () => {
		const acctResult = await upsertAccount(ctx.db, "test", makeAccount({ id: "ext-super", type: "super" }));
		expect(acctResult.ok).toBe(true);
		if (!acctResult.ok) return;
		const accountId = acctResult.value.id;

		await insertContributions(ctx.db, accountId, [
			{ date: "2026-01-15", type: "employer" as const, amount: 1200 },
			{ date: "2026-02-15", type: "employer" as const, amount: 1200 },
			{ date: "2026-03-15", type: "employer" as const, amount: 1200 },
			{ date: "2026-01-15", type: "salary_sacrifice" as const, amount: 500 },
			{ date: "2026-02-15", type: "salary_sacrifice" as const, amount: 500 },
		]);

		const result = await getContributionSummary(ctx.db);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const employer = result.value.find((r) => r.type === "employer");
		expect(employer?.total).toBe(3600);
		expect(employer?.count).toBe(3);

		const salSac = result.value.find((r) => r.type === "salary_sacrifice");
		expect(salSac?.total).toBe(1000);
		expect(salSac?.count).toBe(2);
	});

	// --- Corpus snapshot ---

	it("S11: corpus snapshot created on import", async () => {
		const provider = createTestSuperProvider({
			balance: makeSuperBalance({ balance: 85000 }),
			contributions: [makeContribution({ amount: 1200 })],
		});

		const result = await syncSuper(ctx, provider);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const latest = await ctx.corpus.stores["raw-contributions"].get_latest();
		expect(latest.ok).toBe(true);
		if (!latest.ok) return;
		expect(latest.value.data.balance.amount).toBe(85000);
		expect(latest.value.data.contributions.length).toBe(1);
	});
});

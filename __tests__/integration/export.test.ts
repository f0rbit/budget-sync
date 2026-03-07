import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../../src/db/client.js";
import { accounts, transactions } from "../../src/db/schema.js";
import { type ExportOptions, exportToObsidian } from "../../src/services/export-service.js";
import { createTestContext } from "../helpers.js";

// --- DB seeding helpers ---

function seedAccount(ctx: AppContext): string {
	const row = ctx.db
		.insert(accounts)
		.values({
			id: "test-acct",
			externalId: "ext-1",
			provider: "in-memory",
			name: "Test Account",
			institution: "TestBank",
			type: "transaction",
		})
		.returning()
		.get();
	return row.id;
}

function seedTransaction(ctx: AppContext, accountId: string, overrides?: Partial<typeof transactions.$inferInsert>) {
	return ctx.db
		.insert(transactions)
		.values({
			accountId,
			externalId: overrides?.externalId ?? null,
			date: "2026-03-05",
			postDate: "2026-03-05",
			rawDescription: "WOOLWORTHS/1234 BRISBANE",
			item: "Woolworths",
			amount: 42.5,
			direction: "debit",
			category: "Woolworths",
			notes: "",
			excluded: false,
			...overrides,
		})
		.returning()
		.get();
}

describe("export to Obsidian", () => {
	let ctx: AppContext;
	let tmpDir: string;

	beforeEach(async () => {
		ctx = createTestContext();
		tmpDir = await mkdtemp(join(tmpdir(), "budget-sync-export-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("creates markdown files in correct directory structure", async () => {
		const acctId = seedAccount(ctx);
		seedTransaction(ctx, acctId, { externalId: "exp-1" });
		seedTransaction(ctx, acctId, {
			externalId: "exp-2",
			date: "2026-03-06",
			item: "McDonald's",
			rawDescription: "MCDONALDS BRISBANE",
			category: "Eating Out",
			amount: 15,
		});

		const budgetDir = "Budget";
		const result = exportToObsidian(ctx.db, tmpDir, budgetDir);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.notesCreated).toBe(2);
		expect(result.value.outputDir).toBe(join(tmpDir, budgetDir));

		const files = await readdir(join(tmpDir, budgetDir));
		expect(files.length).toBe(2);
		expect(files.some((f) => f.endsWith(".md"))).toBe(true);
	});

	it("markdown has correct YAML frontmatter", async () => {
		const acctId = seedAccount(ctx);
		seedTransaction(ctx, acctId, {
			externalId: "exp-fm",
			date: "2026-03-05",
			item: "Woolworths",
			rawDescription: "WOOLWORTHS/1234 BRISBANE",
			category: "Woolworths",
			amount: 42.5,
			direction: "debit",
			notes: "BRISBANE",
		});

		const result = exportToObsidian(ctx.db, tmpDir, "Budget");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const files = await readdir(join(tmpDir, "Budget"));
		expect(files.length).toBe(1);

		const fileName = files[0];
		expect(fileName).toBeDefined();
		const content = await readFile(join(tmpDir, "Budget", fileName as string), "utf-8");

		// Check YAML frontmatter structure
		expect(content).toMatch(/^---\n/);
		expect(content).toContain('item: "Woolworths"');
		expect(content).toContain("amount: 42.50");
		expect(content).toContain('category: "Woolworths"');
		expect(content).toContain("direction: debit");
		expect(content).toContain("date: 2026-03-05");
		expect(content).toContain('notes: "BRISBANE"');

		// Check body
		expect(content).toContain("# Woolworths");
		expect(content).toContain("**$42.50** — Woolworths");
		expect(content).toContain("> WOOLWORTHS/1234 BRISBANE");
	});

	it("handles filename collisions with -2, -3 suffixes", async () => {
		const acctId = seedAccount(ctx);
		// Insert 3 transactions on the same date with the same item
		seedTransaction(ctx, acctId, {
			externalId: "dup-1",
			date: "2026-03-05",
			item: "Woolworths",
			rawDescription: "WOOLWORTHS/1234 BRISBANE",
			amount: 30,
		});
		seedTransaction(ctx, acctId, {
			externalId: "dup-2",
			date: "2026-03-05",
			item: "Woolworths",
			rawDescription: "WOOLWORTHS/5678 SYDNEY",
			amount: 45,
		});
		seedTransaction(ctx, acctId, {
			externalId: "dup-3",
			date: "2026-03-05",
			item: "Woolworths",
			rawDescription: "WOOLWORTHS/9999 MELBOURNE",
			amount: 60,
		});

		const result = exportToObsidian(ctx.db, tmpDir, "Budget");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.notesCreated).toBe(3);

		const files = (await readdir(join(tmpDir, "Budget"))).sort();
		expect(files.length).toBe(3);

		// Sorted alphabetically: -2 and -3 come before .md (hyphen < dot in ASCII)
		const fileSet = new Set(files);
		expect(fileSet.has("2026-03-05-woolworths.md")).toBe(true);
		expect(fileSet.has("2026-03-05-woolworths-2.md")).toBe(true);
		expect(fileSet.has("2026-03-05-woolworths-3.md")).toBe(true);
	});

	it("dry-run returns results without writing files", async () => {
		const acctId = seedAccount(ctx);
		seedTransaction(ctx, acctId, { externalId: "dry-1" });

		const options: ExportOptions = { dryRun: true };
		const result = exportToObsidian(ctx.db, tmpDir, "Budget", options);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.notesCreated).toBe(1);

		// Budget dir should NOT exist on disk since dryRun skips mkdir + write
		const budgetPath = join(tmpDir, "Budget");
		const exists = await readdir(budgetPath).then(
			() => true,
			() => false,
		);
		expect(exists).toBe(false);
	});

	it("returns error when vault path does not exist", () => {
		const result = exportToObsidian(ctx.db, "/nonexistent/vault/path", "Budget");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("VAULT_NOT_FOUND");
	});

	it("date filtering limits exported transactions", async () => {
		const acctId = seedAccount(ctx);
		seedTransaction(ctx, acctId, {
			externalId: "date-1",
			date: "2026-02-15",
			item: "February Purchase",
			rawDescription: "FEB SHOP",
		});
		seedTransaction(ctx, acctId, {
			externalId: "date-2",
			date: "2026-03-10",
			item: "March Purchase",
			rawDescription: "MAR SHOP",
		});

		const options: ExportOptions = {
			dateFrom: "2026-03-01",
			dateTo: "2026-03-31",
		};
		const result = exportToObsidian(ctx.db, tmpDir, "Budget", options);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.notesCreated).toBe(1);

		const files = await readdir(join(tmpDir, "Budget"));
		expect(files.length).toBe(1);
		expect(files[0]).toContain("march-purchase");
	});
});

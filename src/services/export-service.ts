import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Result, err, ok, try_catch } from "@f0rbit/corpus";
import { and, desc, gte, lte } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { transactions } from "../db/schema.js";
import { type ExportError, errors } from "../errors.js";

// === Types ===

export interface ExportOptions {
	dateFrom?: string;
	dateTo?: string;
	dryRun?: boolean;
	force?: boolean;
}

export interface ExportSummary {
	notesCreated: number;
	notesSkipped: number;
	outputDir: string;
}

type TransactionRow = typeof transactions.$inferSelect;

// === Functions ===

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/['']/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, 50);
}

function generateFilename(tx: TransactionRow, existingFiles: Set<string>): string {
	const base = `${tx.date}-${slugify(tx.item)}`;
	let filename = `${base}.md`;
	let counter = 2;

	while (existingFiles.has(filename)) {
		filename = `${base}-${counter}.md`;
		counter++;
	}

	existingFiles.add(filename);
	return filename;
}

export function renderNote(tx: TransactionRow): string {
	const lines = [
		"---",
		`date: ${tx.date}`,
		`item: "${tx.item}"`,
		`amount: ${tx.amount.toFixed(2)}`,
		`category: "${tx.category}"`,
		`direction: ${tx.direction}`,
	];

	if (tx.postDate) {
		lines.push(`post_date: ${tx.postDate}`);
	}
	if (tx.notes) {
		lines.push(`notes: "${tx.notes}"`);
	}
	if (tx.excluded) {
		lines.push("excluded: true");
		if (tx.excludeReason) {
			lines.push(`exclude_reason: "${tx.excludeReason}"`);
		}
	}

	lines.push("---");
	lines.push("");
	lines.push(`# ${tx.item}`);
	lines.push("");
	lines.push(`**$${tx.amount.toFixed(2)}** — ${tx.category}`);
	lines.push("");
	lines.push(`> ${tx.rawDescription}`);

	if (tx.notes) {
		lines.push("");
		lines.push(tx.notes);
	}

	lines.push("");
	return lines.join("\n");
}

export function exportToObsidian(
	db: AppDatabase,
	vaultPath: string,
	budgetDir: string,
	options?: ExportOptions,
): Result<ExportSummary, ExportError> {
	const resolvedVault = resolve(vaultPath);

	if (!existsSync(resolvedVault)) {
		return err(errors.vaultNotFound(resolvedVault));
	}

	const outputDir = join(resolvedVault, budgetDir);

	const conditions = [];
	if (options?.dateFrom) {
		conditions.push(gte(transactions.date, options.dateFrom));
	}
	if (options?.dateTo) {
		conditions.push(lte(transactions.date, options.dateTo));
	}

	let query = db.select().from(transactions).orderBy(desc(transactions.date));

	if (conditions.length > 0) {
		query = query.where(and(...conditions)) as typeof query;
	}

	const rows = query.all();

	const existingFiles = new Set<string>();
	let notesCreated = 0;
	let notesSkipped = 0;

	if (!options?.dryRun) {
		const mkdirResult = try_catch(
			() => mkdirSync(outputDir, { recursive: true }),
			(e) => errors.writeFailed(outputDir, `Failed to create directory: ${e}`),
		);
		if (!mkdirResult.ok) return mkdirResult;
	}

	for (const tx of rows) {
		const filename = generateFilename(tx, existingFiles);
		const filePath = join(outputDir, filename);

		if (!options?.force && existsSync(filePath)) {
			notesSkipped++;
			continue;
		}

		if (!options?.dryRun) {
			const writeResult = try_catch(
				() => writeFileSync(filePath, renderNote(tx), "utf-8"),
				(e) => errors.writeFailed(filePath, `Failed to write note: ${e}`),
			);
			if (!writeResult.ok) return writeResult;
		}

		notesCreated++;
	}

	return ok({ notesCreated, notesSkipped, outputDir });
}

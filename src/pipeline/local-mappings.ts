import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Result, err, ok, try_catch } from "@f0rbit/corpus";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import type { PipelineError } from "../errors.js";
import { errors } from "../errors.js";
import type { CategorizedTransaction, MerchantMapping, MerchantMappings, RawTransaction } from "../providers/types.js";

const DEFAULT_MAPPINGS_PATH = "merchant-mappings.jsonc";

export function loadMappings(mappingsPath?: string): Result<MerchantMappings, PipelineError> {
	const resolvedPath = resolve(mappingsPath ?? DEFAULT_MAPPINGS_PATH);

	if (!existsSync(resolvedPath)) {
		return err(errors.mappingLoadFailed(`Mappings file not found: ${resolvedPath}`));
	}

	const readResult = try_catch(
		() => readFileSync(resolvedPath, "utf-8"),
		(e) => errors.mappingLoadFailed(`Failed to read mappings file: ${e}`),
	);
	if (!readResult.ok) return readResult;

	const parseErrors: ParseError[] = [];
	const parsed = parseJsonc(readResult.value, parseErrors);

	if (parseErrors.length > 0) {
		return err(errors.mappingLoadFailed(`Failed to parse JSONC: ${JSON.stringify(parseErrors)}`));
	}

	if (!parsed || typeof parsed !== "object") {
		return err(errors.mappingLoadFailed("Mappings file must contain a JSON object"));
	}

	const mappings: MerchantMapping[] = Array.isArray(parsed.mappings) ? parsed.mappings : [];
	const exclusions = Array.isArray(parsed.exclusions) ? parsed.exclusions : [];

	return ok({ mappings, exclusions });
}

export function matchTransaction(description: string, mappings: MerchantMapping[]): MerchantMapping | null {
	const upper = description.toUpperCase();

	for (const mapping of mappings) {
		if (upper.includes(mapping.match.toUpperCase())) {
			return mapping;
		}
	}

	return null;
}

export function applyMapping(tx: RawTransaction, mapping: MerchantMapping): CategorizedTransaction {
	const item = mapping.item;
	let notes = "";

	if (mapping.extractLocation) {
		const matchIndex = tx.description.toUpperCase().indexOf(mapping.match.toUpperCase());
		if (matchIndex !== -1) {
			const afterMatch = tx.description.substring(matchIndex + mapping.match.length).trim();
			const location = afterMatch.replace(/^\d+\s*/, "").trim();
			if (location) {
				notes = location;
			}
		}
	}

	return {
		externalId: tx.id,
		date: tx.transactionDate,
		postDate: tx.postDate,
		rawDescription: tx.description,
		item,
		amount: tx.amount,
		direction: tx.direction,
		category: mapping.category,
		notes,
		excluded: false,
		accountId: tx.accountId,
	};
}

import { type Result, err, ok } from "@f0rbit/corpus";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import type { AccountType, DocumentParser, ParsedDocument } from "../types.js";

export class InMemoryDocumentParser implements DocumentParser {
	readonly name = "in-memory-parser";

	/** Pre-loaded results keyed by content hash or a default */
	private _results: Map<string, ParsedDocument> = new Map();
	private _defaultResult: ParsedDocument | null = null;

	/** Fail flag — when set, the next parse() call returns an error */
	failNextParse = false;
	/** Custom error for the next failure */
	failError: ProviderError | null = null;

	/** Set a result for a specific content hash */
	setResult(contentHash: string, result: ParsedDocument): void {
		this._results.set(contentHash, result);
	}

	/** Set a default result returned when no hash-specific result exists */
	setDefaultResult(result: ParsedDocument): void {
		this._defaultResult = result;
	}

	async parse(
		content: string,
		mimeType: string,
		accountHint?: { accountName?: string; accountType?: AccountType },
	): Promise<Result<ParsedDocument, ProviderError>> {
		if (this.failNextParse) {
			this.failNextParse = false;
			const error = this.failError ?? errors.apiError(500, "Simulated parse failure");
			this.failError = null;
			return err(error);
		}

		// Try hash-specific result first
		// Use a simple hash of the content for lookup
		const hashKey = content.substring(0, 64); // Use first 64 chars as key for simplicity
		const specific = this._results.get(hashKey);
		if (specific) return ok(specific);

		// Fall back to default
		if (this._defaultResult) return ok(this._defaultResult);

		// No result configured — return empty
		return ok({
			transactions: [],
			notes: ["InMemoryDocumentParser: no result configured for this content"],
		});
	}
}

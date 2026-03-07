import { type Result, err, ok } from "@f0rbit/corpus";
import type { AppConfig } from "../config.js";
import { getAnthropicApiKey } from "../config.js";
import type { ConfigError } from "../errors.js";
import { errors } from "../errors.js";
import { AnthropicAiCategorizer } from "./ai/categorizer.js";
import { AnthropicDocumentParser } from "./ai/parser.js";
import { CsvBankProvider } from "./csv/provider.js";
import { InMemoryAiCategorizer } from "./in-memory/categorizer.js";
import { InMemoryDocumentParser } from "./in-memory/document-parser.js";
import { InMemoryBankProvider } from "./in-memory/provider.js";
import type { AiCategorizer, BankProvider, DocumentParser } from "./types.js";

export function createProvider(
	config: AppConfig,
	options?: { csvFilePath?: string; csvAccountName?: string },
): Result<BankProvider, ConfigError> {
	switch (config.provider) {
		case "csv": {
			if (!options?.csvFilePath) {
				return err(errors.configInvalid("CSV file path is required when provider is 'csv'"));
			}
			return ok(
				new CsvBankProvider({
					filePath: options.csvFilePath,
					accountName: options.csvAccountName ?? "CSV Import",
				}),
			);
		}

		case "manual": {
			return ok(new InMemoryBankProvider());
		}

		default:
			return err(errors.configInvalid(`Unknown provider: ${config.provider}`));
	}
}

export function createDocumentParser(config: AppConfig): Result<DocumentParser, ConfigError> {
	const apiKeyResult = getAnthropicApiKey();
	if (!apiKeyResult.ok) return apiKeyResult;

	return ok(
		new AnthropicDocumentParser({
			apiKey: apiKeyResult.value,
			model: config.anthropic.model,
			maxTokens: config.anthropic.max_tokens,
		}),
	);
}

export function createAiCategorizer(config: AppConfig): Result<AiCategorizer, ConfigError> {
	const apiKeyResult = getAnthropicApiKey();
	if (!apiKeyResult.ok) return apiKeyResult;

	return ok(
		new AnthropicAiCategorizer({
			apiKey: apiKeyResult.value,
			model: config.anthropic.model,
			maxTokens: config.anthropic.max_tokens,
		}),
	);
}

export type { BankProvider } from "./types.js";
export type { DocumentParser, ParsedDocument } from "./types.js";
export type { AiCategorizer } from "./types.js";
export { CsvBankProvider } from "./csv/provider.js";
export { InMemoryBankProvider } from "./in-memory/provider.js";
export { InMemoryDocumentParser } from "./in-memory/document-parser.js";
export { AnthropicDocumentParser } from "./ai/parser.js";
export { AnthropicAiCategorizer } from "./ai/categorizer.js";
export { InMemoryAiCategorizer } from "./in-memory/categorizer.js";

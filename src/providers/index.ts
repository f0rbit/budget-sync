import { type Result, ok } from "@f0rbit/corpus";
import type { AppConfig } from "../config.js";
import { getAnthropicApiKey } from "../config.js";
import type { ConfigError } from "../errors.js";
import { AnthropicAiCategorizer } from "./ai/categorizer.js";
import { AnthropicDocumentParser } from "./ai/parser.js";
import { InMemoryAiCategorizer } from "./in-memory/categorizer.js";
import { InMemoryDocumentParser } from "./in-memory/document-parser.js";
import type { AiCategorizer, DocumentParser } from "./types.js";

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

export type { DocumentParser, ParsedDocument } from "./types.js";
export type { AiCategorizer } from "./types.js";
export { InMemoryDocumentParser } from "./in-memory/document-parser.js";
export { AnthropicDocumentParser } from "./ai/parser.js";
export { AnthropicAiCategorizer } from "./ai/categorizer.js";
export { InMemoryAiCategorizer } from "./in-memory/categorizer.js";

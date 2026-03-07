import type { FetchError } from "@f0rbit/corpus";

// === Provider Errors ===
export type ProviderError =
	| { code: "AUTH_FAILED"; message: string }
	| { code: "RATE_LIMITED"; message: string; retryAfter?: number }
	| { code: "NOT_FOUND"; message: string; resource: string }
	| { code: "API_ERROR"; message: string; status: number }
	| { code: "NETWORK_ERROR"; message: string }
	| { code: "PARSE_ERROR"; message: string; raw?: string };

// === Config Errors ===
export type ConfigError =
	| { code: "CONFIG_NOT_FOUND"; path: string }
	| { code: "CONFIG_INVALID"; message: string; errors?: unknown };

// === Database Errors ===
export type DbError =
	| { code: "DB_ERROR"; message: string; cause?: unknown }
	| { code: "DUPLICATE"; message: string; externalId: string };

// === Pipeline Errors ===
export type PipelineError =
	| { code: "MAPPING_LOAD_FAILED"; message: string }
	| { code: "CATEGORIZATION_FAILED"; message: string; transactionId: string }
	| { code: "AI_CATEGORIZATION_FAILED"; message: string };

// === Export Errors ===
export type ExportError =
	| { code: "WRITE_FAILED"; path: string; message: string }
	| { code: "VAULT_NOT_FOUND"; path: string };

// === Union of all errors ===
export type AppError = ProviderError | ConfigError | DbError | PipelineError | ExportError;

// === Error constructor helpers ===

export const errors = {
	authFailed: (message: string): ProviderError => ({
		code: "AUTH_FAILED",
		message,
	}),
	rateLimited: (message: string, retryAfter?: number): ProviderError => ({
		code: "RATE_LIMITED",
		message,
		retryAfter,
	}),
	notFound: (resource: string, message: string): ProviderError => ({
		code: "NOT_FOUND",
		message,
		resource,
	}),
	apiError: (status: number, message: string): ProviderError => ({
		code: "API_ERROR",
		message,
		status,
	}),
	networkError: (message: string): ProviderError => ({
		code: "NETWORK_ERROR",
		message,
	}),
	parseError: (message: string, raw?: string): ProviderError => ({
		code: "PARSE_ERROR",
		message,
		raw,
	}),

	configNotFound: (path: string): ConfigError => ({
		code: "CONFIG_NOT_FOUND",
		path,
	}),
	configInvalid: (message: string, errors?: unknown): ConfigError => ({
		code: "CONFIG_INVALID",
		message,
		errors,
	}),

	dbError: (message: string, cause?: unknown): DbError => ({
		code: "DB_ERROR",
		message,
		cause,
	}),
	duplicate: (externalId: string, message: string): DbError => ({
		code: "DUPLICATE",
		message,
		externalId,
	}),

	mappingLoadFailed: (message: string): PipelineError => ({
		code: "MAPPING_LOAD_FAILED",
		message,
	}),
	categorizationFailed: (transactionId: string, message: string): PipelineError => ({
		code: "CATEGORIZATION_FAILED",
		message,
		transactionId,
	}),
	aiCategorizationFailed: (message: string): PipelineError => ({
		code: "AI_CATEGORIZATION_FAILED",
		message,
	}),

	writeFailed: (path: string, message: string): ExportError => ({
		code: "WRITE_FAILED",
		path,
		message,
	}),
	vaultNotFound: (path: string): ExportError => ({
		code: "VAULT_NOT_FOUND",
		path,
	}),

	fromFetchError: (e: FetchError): ProviderError => {
		if (e.type === "network") return { code: "NETWORK_ERROR", message: String(e.cause) };
		if (e.status === 401 || e.status === 403)
			return {
				code: "AUTH_FAILED",
				message: `HTTP ${e.status}: ${e.status_text}`,
			};
		if (e.status === 429)
			return {
				code: "RATE_LIMITED",
				message: `HTTP 429: ${e.status_text}`,
			};
		if (e.status === 404)
			return {
				code: "NOT_FOUND",
				message: `HTTP 404: ${e.status_text}`,
				resource: "unknown",
			};
		return {
			code: "API_ERROR",
			message: `HTTP ${e.status}: ${e.status_text}`,
			status: e.status,
		};
	},
} as const;

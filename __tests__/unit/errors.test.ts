import { describe, expect, it } from "bun:test";
import type { FetchError } from "@f0rbit/corpus";
import { errors } from "../../src/errors.js";

describe("error constructors", () => {
	it("authFailed", () => {
		const e = errors.authFailed("msg");
		expect(e).toEqual({ code: "AUTH_FAILED", message: "msg" });
	});

	it("rateLimited with retryAfter", () => {
		const e = errors.rateLimited("msg", 30);
		expect(e).toEqual({ code: "RATE_LIMITED", message: "msg", retryAfter: 30 });
	});

	it("rateLimited without retryAfter", () => {
		const e = errors.rateLimited("msg");
		expect(e.code).toBe("RATE_LIMITED");
		expect(e).toHaveProperty("retryAfter", undefined);
	});

	it("notFound", () => {
		const e = errors.notFound("users", "msg");
		expect(e).toEqual({ code: "NOT_FOUND", message: "msg", resource: "users" });
	});

	it("apiError", () => {
		const e = errors.apiError(500, "msg");
		expect(e).toEqual({ code: "API_ERROR", message: "msg", status: 500 });
	});

	it("networkError", () => {
		const e = errors.networkError("msg");
		expect(e).toEqual({ code: "NETWORK_ERROR", message: "msg" });
	});

	it("parseError with raw", () => {
		const e = errors.parseError("msg", "raw");
		expect(e).toEqual({ code: "PARSE_ERROR", message: "msg", raw: "raw" });
	});

	it("parseError without raw", () => {
		const e = errors.parseError("msg");
		expect(e.code).toBe("PARSE_ERROR");
		expect(e).toHaveProperty("raw", undefined);
	});

	it("configNotFound", () => {
		const e = errors.configNotFound("/path");
		expect(e).toEqual({ code: "CONFIG_NOT_FOUND", path: "/path" });
		expect(e).not.toHaveProperty("message");
	});

	it("configInvalid with errors", () => {
		const e = errors.configInvalid("msg", ["e1"]);
		expect(e).toEqual({ code: "CONFIG_INVALID", message: "msg", errors: ["e1"] });
	});

	it("configInvalid without errors", () => {
		const e = errors.configInvalid("msg");
		expect(e.code).toBe("CONFIG_INVALID");
		expect(e).toHaveProperty("errors", undefined);
	});

	it("dbError with cause", () => {
		const cause = new Error("cause");
		const e = errors.dbError("msg", cause);
		expect(e).toEqual({ code: "DB_ERROR", message: "msg", cause });
	});

	it("dbError without cause", () => {
		const e = errors.dbError("msg");
		expect(e.code).toBe("DB_ERROR");
		expect(e).toHaveProperty("cause", undefined);
	});

	it("duplicate", () => {
		const e = errors.duplicate("ext-1", "msg");
		expect(e).toEqual({ code: "DUPLICATE", message: "msg", externalId: "ext-1" });
	});

	it("mappingLoadFailed", () => {
		const e = errors.mappingLoadFailed("msg");
		expect(e).toEqual({ code: "MAPPING_LOAD_FAILED", message: "msg" });
	});

	it("categorizationFailed", () => {
		const e = errors.categorizationFailed("tx-1", "msg");
		expect(e).toEqual({ code: "CATEGORIZATION_FAILED", message: "msg", transactionId: "tx-1" });
	});

	it("writeFailed", () => {
		const e = errors.writeFailed("/path", "msg");
		expect(e).toEqual({ code: "WRITE_FAILED", path: "/path", message: "msg" });
	});

	it("vaultNotFound", () => {
		const e = errors.vaultNotFound("/path");
		expect(e).toEqual({ code: "VAULT_NOT_FOUND", path: "/path" });
	});
});

describe("fromFetchError", () => {
	it("converts network error", () => {
		const fe = { type: "network", cause: new Error("timeout") } as FetchError;
		const e = errors.fromFetchError(fe);
		expect(e).toEqual({ code: "NETWORK_ERROR", message: "Error: timeout" });
	});

	it("converts 401 to AUTH_FAILED", () => {
		const fe = { type: "http", status: 401, status_text: "Unauthorized", body: null } as FetchError;
		const e = errors.fromFetchError(fe);
		expect(e).toEqual({ code: "AUTH_FAILED", message: "HTTP 401: Unauthorized" });
	});

	it("converts 403 to AUTH_FAILED", () => {
		const fe = { type: "http", status: 403, status_text: "Forbidden", body: null } as FetchError;
		const e = errors.fromFetchError(fe);
		expect(e).toEqual({ code: "AUTH_FAILED", message: "HTTP 403: Forbidden" });
	});

	it("converts 429 to RATE_LIMITED", () => {
		const fe = { type: "http", status: 429, status_text: "Too Many Requests", body: null } as FetchError;
		const e = errors.fromFetchError(fe);
		expect(e).toEqual({ code: "RATE_LIMITED", message: "HTTP 429: Too Many Requests" });
	});

	it("converts 404 to NOT_FOUND", () => {
		const fe = { type: "http", status: 404, status_text: "Not Found", body: null } as FetchError;
		const e = errors.fromFetchError(fe);
		expect(e).toEqual({ code: "NOT_FOUND", message: "HTTP 404: Not Found", resource: "unknown" });
	});

	it("converts generic HTTP status to API_ERROR", () => {
		const fe = { type: "http", status: 500, status_text: "Internal Server Error", body: null } as FetchError;
		const e = errors.fromFetchError(fe);
		expect(e).toEqual({ code: "API_ERROR", message: "HTTP 500: Internal Server Error", status: 500 });
	});
});

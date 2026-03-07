import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Result, err, ok, try_catch } from "@f0rbit/corpus";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { type ConfigError, errors } from "./errors.js";

// === Zod Schema ===

export const rentConfigSchema = z.object({
	solo_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
	solo_weekly_amount: z.number().positive(),
	shared_roommate_contribution: z.number().nonnegative(),
	landlord_patterns: z.array(z.string()),
	debit_rent_patterns: z.array(z.string()),
});

export const syncConfigSchema = z.object({
	default_range_days: z.number().int().positive().default(30),
	auto_snapshot: z.boolean().default(true),
});

export const configSchema = z.object({
	db_path: z.string().default("./data/budget-sync.db"),
	corpus_dir: z.string().default("./data/corpus"),
	vault_path: z.string(),
	budget_dir: z.string().default("Budget"),
	provider: z.enum(["csv", "manual"]).default("manual"),
	sync: syncConfigSchema.default({}),
	rent: rentConfigSchema,
});

export type AppConfig = z.infer<typeof configSchema>;
export type RentConfig = z.infer<typeof rentConfigSchema>;
export type SyncConfig = z.infer<typeof syncConfigSchema>;

// === Config Loader ===

const DEFAULT_CONFIG_PATH = "config.jsonc";

export function loadConfig(configPath?: string): Result<AppConfig, ConfigError> {
	const resolved_path = resolve(configPath ?? DEFAULT_CONFIG_PATH);

	if (!existsSync(resolved_path)) {
		return err(errors.configNotFound(resolved_path));
	}

	const read_result = try_catch(
		() => readFileSync(resolved_path, "utf-8"),
		(e) => errors.configInvalid(`Failed to read config file: ${e}`),
	);
	if (!read_result.ok) return read_result;

	const parse_errors: ParseError[] = [];
	const parsed = parseJsonc(read_result.value, parse_errors);

	if (parse_errors.length > 0) {
		return err(errors.configInvalid("Failed to parse JSONC", parse_errors));
	}

	const validation = configSchema.safeParse(parsed);
	if (!validation.success) {
		return err(errors.configInvalid(`Config validation failed: ${validation.error.message}`, validation.error.issues));
	}

	return ok(validation.data);
}

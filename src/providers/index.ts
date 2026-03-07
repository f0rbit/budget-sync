import { type Result, err, ok } from "@f0rbit/corpus";
import type { AppConfig } from "../config.js";
import type { ConfigError } from "../errors.js";
import { errors } from "../errors.js";
import { CsvBankProvider } from "./csv/provider.js";
import { InMemoryBankProvider } from "./in-memory/provider.js";
import type { BankProvider } from "./types.js";

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

export type { BankProvider } from "./types.js";
export { CsvBankProvider } from "./csv/provider.js";
export { InMemoryBankProvider } from "./in-memory/provider.js";

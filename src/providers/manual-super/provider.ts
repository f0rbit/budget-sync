import { readFileSync } from "node:fs";
import { type Result, err, ok, try_catch } from "@f0rbit/corpus";
import { z } from "zod";
import { errors } from "../../errors.js";
import type { ProviderError } from "../../errors.js";
import type { ContributionType, DateRange, SuperBalance, SuperContribution, SuperProvider } from "../types.js";

const CONTRIBUTION_TYPE_VALUES = ["employer", "salary_sacrifice", "voluntary", "fhss", "government"] as const;

const superImportSchema = z.object({
	balance: z.object({
		amount: z.number(),
		asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	}),
	contributions: z
		.array(
			z.object({
				date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
				type: z.enum(CONTRIBUTION_TYPE_VALUES),
				amount: z.number().positive(),
				description: z.string().optional(),
			}),
		)
		.default([]),
});

export type SuperImportData = z.infer<typeof superImportSchema>;

export class ManualSuperProvider implements SuperProvider {
	readonly name = "manual-super";
	private data: SuperImportData | null = null;
	private readonly filePath: string;
	private readonly accountId: string;

	constructor(options: { filePath: string; accountId?: string }) {
		this.filePath = options.filePath;
		this.accountId = options.accountId ?? "manual-super";
	}

	async authenticate(): Promise<Result<void, ProviderError>> {
		const readResult = try_catch(
			() => {
				const content = readFileSync(this.filePath, "utf-8");
				return JSON.parse(content);
			},
			(e) => errors.parseError(`Failed to read super import file: ${e}`),
		);
		if (!readResult.ok) return readResult;

		const parsed = superImportSchema.safeParse(readResult.value);
		if (!parsed.success) {
			return err(errors.parseError(`Invalid super import format: ${parsed.error.message}`));
		}

		this.data = parsed.data;
		return ok(undefined);
	}

	async getBalance(): Promise<Result<SuperBalance, ProviderError>> {
		if (!this.data) return err(errors.authFailed("Not authenticated"));
		return ok({
			accountId: this.accountId,
			balance: this.data.balance.amount,
			asOf: this.data.balance.asOf,
		});
	}

	async getContributions(range: DateRange): Promise<Result<SuperContribution[], ProviderError>> {
		if (!this.data) return err(errors.authFailed("Not authenticated"));
		const filtered = this.data.contributions
			.filter((c) => c.date >= range.from && c.date <= range.to)
			.map((c, i) => ({
				id: `manual-${c.date}-${c.type}-${i}`,
				date: c.date,
				type: c.type as ContributionType,
				amount: c.amount,
				description: c.description,
			}));
		return ok(filtered);
	}
}

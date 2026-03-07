import { type Result, Semaphore, err, fetch_result, ok } from "@f0rbit/corpus";
import type { ProviderError } from "../../errors.js";
import { errors } from "../../errors.js";
import { type BasiqTokenResponse, basiqTokenResponseSchema } from "./types.js";

const rateLimiter = new Semaphore(10);

export class BasiqClient {
	private apiUrl: string;
	private apiKey: string;
	private token: string | null = null;
	private tokenExpiresAt = 0;

	constructor(apiUrl: string, apiKey: string) {
		this.apiUrl = apiUrl.replace(/\/$/, "");
		this.apiKey = apiKey;
	}

	async authenticate(): Promise<Result<void, ProviderError>> {
		if (this.token && Date.now() < this.tokenExpiresAt - 60000) {
			return ok(undefined);
		}

		const encoded = btoa(`${this.apiKey}:`);

		const result = await fetch_result<BasiqTokenResponse, ProviderError>(
			`${this.apiUrl}/token`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${encoded}`,
					"Content-Type": "application/x-www-form-urlencoded",
					"basiq-version": "3.0",
				},
				body: "scope=SERVER_ACCESS",
			},
			errors.fromFetchError,
		);

		if (!result.ok) return result;

		const parsed = basiqTokenResponseSchema.safeParse(result.value);
		if (!parsed.success) {
			return err(errors.parseError("Invalid token response", JSON.stringify(result.value)));
		}

		this.token = parsed.data.access_token;
		this.tokenExpiresAt = Date.now() + parsed.data.expires_in * 1000;

		return ok(undefined);
	}

	async get<T>(path: string, parseBody?: (res: Response) => Promise<T>): Promise<Result<T, ProviderError>> {
		const authResult = await this.authenticate();
		if (!authResult.ok) return authResult;

		await rateLimiter.acquire();
		try {
			const url = path.startsWith("http") ? path : `${this.apiUrl}${path}`;

			return await fetch_result<T, ProviderError>(
				url,
				{
					method: "GET",
					headers: {
						Authorization: `Bearer ${this.token}`,
						"basiq-version": "3.0",
						Accept: "application/json",
					},
				},
				errors.fromFetchError,
				parseBody,
			);
		} finally {
			rateLimiter.release();
		}
	}

	async getAllPages<TPage, TItem>(
		initialPath: string,
		extractData: (page: TPage) => TItem[],
		getNext: (page: TPage) => string | undefined,
	): Promise<Result<TItem[], ProviderError>> {
		const allItems: TItem[] = [];
		let nextPath: string | undefined = initialPath;

		while (nextPath) {
			const pageResult = await this.get<TPage>(nextPath);
			if (!pageResult.ok) return pageResult;

			const items = extractData(pageResult.value);
			allItems.push(...items);

			nextPath = getNext(pageResult.value);
		}

		return ok(allItems);
	}

	get baseUrl(): string {
		return this.apiUrl;
	}
}

import { createHash } from "node:crypto";

/**
 * Generate a stable external ID from transaction content.
 * Uses sha256 hash of date|description|amount|direction, truncated to 16 hex chars.
 * Prefix distinguishes the source parser.
 */
export function generateExternalId(
	prefix: string,
	tx: { date: string; description: string; amount: number; direction: string },
): string {
	const hash = createHash("sha256")
		.update(`${tx.date}|${tx.description}|${tx.amount}|${tx.direction}`)
		.digest("hex")
		.substring(0, 16);
	return `${prefix}-${hash}`;
}

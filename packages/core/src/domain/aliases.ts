/**
 * Aliases: the other names a person or entity answers to (#1023, ADR-092).
 *
 * Since migration 110 an alias lives in `entities.aliases text[]` (GIN-indexed,
 * projected through the `people` view). Before it, the worker's merge path wrote
 * them into `properties.aliases` as a jsonb array, and migration 111 copies those
 * into the column. Readers here take the UNION of both shapes, for two reasons:
 * the code deploys before the owner pushes the migrations (for an unknown window
 * the column does not exist), and the worker merge path still writes the jsonb
 * shape until its follow-up lands. One reader, both shapes, no gap.
 */

/** Trim, drop blanks, dedupe case-insensitively; the first spelling seen wins. */
export function normalizeAliases(values: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

/** Every alias a row carries: the column first, then the legacy jsonb array. */
export function collectAliases(row: {
	aliases?: readonly string[] | null;
	properties?: Record<string, unknown> | null;
}): string[] {
	const legacy = row.properties?.aliases;
	return normalizeAliases([...(row.aliases ?? []), ...(Array.isArray(legacy) ? legacy : [])]);
}

/**
 * True when PostgREST rejected a request because `column` does not exist —
 * Postgres' `42703 undefined_column` on a select, or PostgREST's own
 * `PGRST204` schema-cache miss on a write. Used to fall back to the
 * pre-migration column list rather than failing the read.
 */
export function isMissingColumnError(
	error: { code?: string; message?: string } | null | undefined,
	column: string,
): boolean {
	if (!error) return false;
	if (error.code !== "42703" && error.code !== "PGRST204") return false;
	// Whole-word, so "hot" does not match a missing "photo" column.
	return new RegExp(`\\b${column.replace(/[^a-z0-9_]/gi, "")}\\b`).test(error.message ?? "");
}

// The days a Daily Log entry accounts for (#1016, #1487, ADR-051 Amendment 4).
//
// An entry's `Date` is the day it was WRITTEN. Coverage is a projection over the marker
// ledger, bucketed on the atoms' `captured_at` (ADR-050 §8, ADR-088 §3). A catch-up run
// consumes atoms captured on earlier days, so its entry was dated one day while its
// markers landed on others, and the duplicate guard, keyed on `Date`, then held a day
// the entry never covered. The entry now DECLARES what it covers; the ledger stays
// authoritative, and `Covers` is the Notion-side statement of it.
//
// An EMPTY `Covers` means the entry's own `Date`. That is how every entry written before
// the property existed reads, and it is why there is no backfill: no Confirmed page is
// rewritten, so the ADR-038 human gate is untouched.

export type DailyLogDatabaseSchema = {
	properties: Array<{
		name: string;
		type: string;
		options?: string[];
	}>;
};

export type DailyLogPagePropertyValue = {
	date?: { start?: string | null } | null;
	rich_text?: Array<{ plain_text?: string }>;
	multi_select?: Array<{ name?: string }>;
	[key: string]: unknown;
};

export type DailyLogPage = {
	id?: string;
	url?: string;
	properties?: Record<string, DailyLogPagePropertyValue | Record<string, unknown>>;
	[key: string]: unknown;
};

/** The config role that names the Covers property (see dosConfig.ts `role`). */
export const COVERS_ROLE = "covers";

/** Notion property types the writer can put a list of ISO dates into. */
export const COVERS_TYPES = ["rich_text", "multi_select"] as const;
export type CoversType = (typeof COVERS_TYPES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The caller's covered days, validated, deduped and sorted. None given means the entry
 * closes its own day: `[date]`.
 */
export function normalizeCovers(covers: string[] | undefined, date: string): string[] {
	if (!covers || covers.length === 0) return [date];
	for (const d of covers) {
		if (!ISO_DATE.test(d)) {
			throw new Error("`covers` must hold YYYY-MM-DD dates, got '" + d + "'.");
		}
	}
	return [...new Set(covers)].sort();
}

/** The live type of the declared Covers property, or null when it cannot carry dates. */
export function coversType(schema: DailyLogDatabaseSchema, name: string): CoversType | null {
	const hit = schema.properties.find((p) => p.name === name);
	return hit && (COVERS_TYPES as readonly string[]).includes(hit.type)
		? (hit.type as CoversType)
		: null;
}

/** The Notion REST value for a list of covered dates. */
export function coversValue(type: CoversType, covers: string[]): Record<string, unknown> {
	return type === "multi_select"
		? { multi_select: covers.map((name) => ({ name })) }
		: { rich_text: [{ text: { content: covers.join(", ") } }] };
}

/**
 * One query for every entry that could already cover one of these days: any entry
 * whose Covers holds one of them, and any entry DATED one of them (which covers it only
 * if its own Covers is empty; {@link effectiveCovers} decides that client-side, since
 * Notion's two-level nesting limit cannot say "empty AND dated" inside an `or`).
 */
export function coversGuardFilter(
	coversProperty: string,
	type: CoversType,
	dateProperty: string,
	covers: string[],
): Record<string, unknown> {
	return {
		or: [
			...covers.map((d) => ({ property: coversProperty, [type]: { contains: d } })),
			...covers.map((d) => ({ property: dateProperty, date: { equals: d } })),
		],
	};
}

/** The days an existing entry covers: its Covers, or its own Date when Covers is empty. */
export function effectiveCovers(
	page: DailyLogPage,
	coversProperty: string,
	dateProperty: string,
): string[] {
	const value = page.properties?.[coversProperty] as DailyLogPagePropertyValue | undefined;
	const declared = value?.multi_select
		? value.multi_select.map((o) => o.name ?? "").filter((n) => ISO_DATE.test(n))
		: (value?.rich_text ?? [])
				.map((r) => r.plain_text ?? "")
				.join("")
				.split(", ")
				.map((s) => s.trim())
				.filter((s) => ISO_DATE.test(s));
	if (declared.length > 0) return declared;
	const ownProp = page.properties?.[dateProperty] as DailyLogPagePropertyValue | undefined;
	const own = ownProp?.date?.start?.slice(0, 10);
	return own ? [own] : [];
}

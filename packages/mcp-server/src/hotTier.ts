/**
 * The hot tier (#1023, ADR-092): a hand-curated decoder ring rendered into the
 * MCP handshake instructions, next to the owner's tone rules.
 *
 * ahOS memory is otherwise all-deep: every lookup is a tool call, so in practice
 * nothing decodes "chase logicrays re the IP assignment" — no agent calls
 * people_match on four tokens of a one-line request. The instructions are the one
 * channel every surface loads on every connection without a call, so a small
 * table there is a cache for WILLINGNESS, not speed.
 *
 * Selection is by hand: `entities.hot = true` (migration 110), set through
 * people_update / entities_update. Rendering is two tables — people, then terms
 * and every other hot entity — each `Name | Aliases | Gloss`. It is paid on every
 * connection, so the section is hard-capped at {@link HOT_TIER_MAX_LINES} lines;
 * the builder truncates and logs rather than growing.
 */
import { supabase } from "./supabase.js";
import { getCurrentUserId } from "./identity.js";
import { collectAliases } from "./aliases.js";

/** Hard cap on the rendered section, header lines included (the plugin's ~100-line rule). */
export const HOT_TIER_MAX_LINES = 100;

/** Ceiling on rows read; well above what the cap can render, so truncation is visible. */
const HOT_TIER_READ_LIMIT = 300;

/** Longest a gloss cell may run before it is cut. One line means one line. */
const GLOSS_MAX_CHARS = 120;

export type HotTierRow = {
	id: string;
	entity_type: string;
	title: string | null;
	description: string | null;
	properties: Record<string, unknown> | null;
	aliases?: string[] | null;
};

export type RenderedHotTier = {
	/** The section, or "" when nothing is hot. */
	text: string;
	/** Line count of `text` (0 when empty). */
	lines: number;
	/** Hot rows that did not fit under the cap. */
	omitted: number;
};

/** Escape a table cell: pipes would split it, newlines would end the row. */
function cell(value: string): string {
	return value.replace(/\s*\n[\s\S]*$/, "").replace(/\|/g, "\\|").trim();
}

function firstLine(value: string | null | undefined): string {
	return (value ?? "").split("\n")[0].trim();
}

function clip(value: string): string {
	return value.length > GLOSS_MAX_CHARS ? `${value.slice(0, GLOSS_MAX_CHARS - 1)}…` : value;
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * One line saying what a row IS, so the decode lands on a meaning, not a name:
 * - a person: "role, organization", else their bio's first line;
 * - a term: "expansion (context)", else its description, else "term";
 * - anything else: "<kind>: <description>", so a codename that collides with a
 *   company name ("oracle") says which of the two it is.
 */
function gloss(row: HotTierRow): string {
	const props = row.properties ?? {};
	const description = firstLine(row.description);
	if (row.entity_type === "people") {
		const roleOrg = [str(props.role), str(props.organization)].filter(Boolean).join(", ");
		return roleOrg || description;
	}
	if (row.entity_type === "term") {
		const expansion = str(props.expansion);
		const context = str(props.context);
		if (expansion) return context ? `${expansion} (${context})` : expansion;
		return description || "term";
	}
	return description ? `${row.entity_type}: ${description}` : row.entity_type;
}

function renderRow(row: HotTierRow): string {
	const aliases = collectAliases(row);
	return `| ${cell(row.title ?? "(untitled)")} | ${aliases.length ? cell(aliases.join(", ")) : "—"} | ${cell(clip(gloss(row))) || "—"} |`;
}

const PREAMBLE = [
	"Hot tier (source of truth: entities.hot — hand-curated, ADR-092). Decode shorthand in the user's requests with these tables BEFORE asking or searching: a nickname, acronym or codename in a request means the Name on its row.",
	"For more than the gloss, one call goes a hop deeper: entity_neighbourhood({ title_contains: \"<Name>\" }).",
];
const TABLE_HEAD = ["| Name | Aliases | Gloss |", "| --- | --- | --- |"];

/**
 * Render the hot rows as the handshake section, never exceeding `maxLines`.
 * When both tables overflow they share the budget evenly (a long people list
 * cannot starve the terms), and any remainder goes to whichever table needs it.
 */
export function renderHotTier(rows: HotTierRow[], maxLines: number = HOT_TIER_MAX_LINES): RenderedHotTier {
	if (rows.length === 0) return { text: "", lines: 0, omitted: 0 };

	const people = rows.filter((row) => row.entity_type === "people");
	const others = rows.filter((row) => row.entity_type !== "people");
	// Terms lead the second table: they are the rows with no other home.
	others.sort((a, b) => Number(b.entity_type === "term") - Number(a.entity_type === "term"));

	const tableOverhead = (n: number) => (n > 0 ? 1 + TABLE_HEAD.length : 0); // heading line, then the table head
	const fixed = PREAMBLE.length + tableOverhead(people.length) + tableOverhead(others.length);

	let budget = maxLines - fixed;
	const needsAll = people.length + others.length <= budget;
	if (!needsAll) budget -= 1; // the "omitted" line
	budget = Math.max(0, budget);

	let peopleSlots = Math.min(people.length, Math.max(Math.floor(budget / 2), budget - others.length));
	let otherSlots = Math.min(others.length, budget - peopleSlots);
	peopleSlots = Math.min(people.length, budget - otherSlots);

	const shownPeople = people.slice(0, peopleSlots);
	const shownOthers = others.slice(0, otherSlots);
	const omitted = rows.length - shownPeople.length - shownOthers.length;

	const lines: string[] = [...PREAMBLE];
	if (people.length > 0) {
		lines.push("People:", ...TABLE_HEAD, ...shownPeople.map(renderRow));
	}
	if (others.length > 0) {
		lines.push("Terms and entities:", ...TABLE_HEAD, ...shownOthers.map(renderRow));
	}
	if (omitted > 0) {
		lines.push(`(${omitted} more hot rows omitted: the hot tier is capped at ${maxLines} lines. Unmark some with hot: false.)`);
		console.error(
			`[hotTier] hot tier truncated: ${omitted} of ${rows.length} hot rows omitted to stay within ${maxLines} lines`,
		);
	}

	return { text: lines.join("\n"), lines: lines.length, omitted };
}

/**
 * The owner's live hot rows. Total-function like loadToneRules: any failure —
 * including the `hot` / `aliases` columns not existing yet because migration 110
 * has not been pushed — degrades to no tier, so the handshake never blocks on it.
 */
export async function loadHotTier(): Promise<HotTierRow[]> {
	try {
		const { data, error } = await supabase
			.from("entities")
			.select("id, entity_type, title, description, properties, aliases")
			.eq("user_id", getCurrentUserId())
			.eq("hot", true)
			.eq("archived", false)
			.order("updated_at", { ascending: false, nullsFirst: false })
			.limit(HOT_TIER_READ_LIMIT);
		if (error || !data) return [];
		return data as HotTierRow[];
	} catch {
		return [];
	}
}

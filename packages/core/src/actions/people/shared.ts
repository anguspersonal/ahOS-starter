import { z } from "zod";
import { collectAliases } from "../../domain/aliases.js";
import type { PersonRow } from "../../ports/people.js";

/**
 * Ceiling on rows pulled from the database when `query` has to be applied in JS (#423).
 */
export const PEOPLE_SCAN_LIMIT = 2000;

export const peopleGetInput = {
	id: z.string().uuid().describe("Person id."),
} as const;

export const peopleQueryInput = {
	query: z
		.string()
		.min(1)
		.optional()
		.describe("Filter by name, role, organization, email, or relationship."),
	ids: z.array(z.string().uuid()).optional().describe("Limit the operation to these ids."),
	team_id: z.string().uuid().optional().describe("Filter by team id."),
	user_id: z
		.string()
		.uuid()
		.optional()
		.describe("Filter by user id. Defaults to the current MCP user."),
	include_archived: z.boolean().optional().describe("Include archived rows. Defaults to false."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max rows returned after `query` is applied (default 20)."),
} as const;

export const peopleGetSchema = z.object(peopleGetInput);
export const peopleQuerySchema = z.object(peopleQueryInput);

export type PersonGetInput = z.infer<typeof peopleGetSchema>;
export type PersonQueryInput = z.infer<typeof peopleQuerySchema>;

const RELATIONSHIP_SYNONYM_GROUPS: readonly (readonly string[])[] = [
	[
		"partner",
		"life partner",
		"fiance",
		"fiancee",
		"engaged",
		"spouse",
		"wife",
		"husband",
		"girlfriend",
		"boyfriend",
		"significant other",
	],
	["colleague", "coworker", "co-worker", "teammate", "peer"],
	["manager", "boss", "supervisor", "line manager"],
	["friend", "close friend", "mate", "pal"],
];

export function normalizePersonText(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordBoundedTerm(text: string, term: string): boolean {
	if (!text || !term) return false;
	return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text);
}

export function relationshipsMatch(
	stored: string | null | undefined,
	query: string | null | undefined,
): boolean {
	if (!stored || !query) return false;
	const s = normalizePersonText(stored);
	const q = normalizePersonText(query);
	if (!s || !q) return false;
	if (s === q) return true;
	if (
		(q.length >= 4 && hasWordBoundedTerm(s, q)) ||
		(s.length >= 4 && hasWordBoundedTerm(q, s))
	) {
		return true;
	}
	return RELATIONSHIP_SYNONYM_GROUPS.some(
		(group) =>
			group.some((term) => s === term || hasWordBoundedTerm(s, term)) &&
			group.some((term) => q === term || hasWordBoundedTerm(q, term)),
	);
}

export function collectPreviousEmails(person: {
	properties?: Record<string, unknown> | null;
}): string[] {
	const raw = person.properties?.previous_emails;
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const normalized = entry.trim().toLowerCase();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

export function matchesPersonQuery(person: PersonRow, needle: string): boolean {
	const normNeedle = normalizePersonText(needle);
	const fieldMatch = [
		person.name,
		person.organization,
		person.role,
		person.email,
		person.relationship,
		person.source_url,
		...collectAliases(person),
		...collectPreviousEmails(person),
	]
		.filter((value): value is string => typeof value === "string")
		.some(
			(value) =>
				value.toLowerCase().includes(needle) ||
				normalizePersonText(value).includes(normNeedle),
		);
	return fieldMatch || relationshipsMatch(person.relationship, needle);
}

export function formatPersonRow(person: PersonRow): string {
	const aliases = collectAliases(person);
	const parts = [
		person.name ?? "(unnamed)",
		aliases.length ? `aka: ${aliases.join(", ")}` : null,
		person.role ? `role: ${person.role}` : null,
		person.organization ? `org: ${person.organization}` : null,
		person.email ? `email: ${person.email}` : null,
		person.phone ? `phone: ${person.phone}` : null,
		person.relationship ? `rel: ${person.relationship}` : null,
		person.last_contact ? `last_contact: ${person.last_contact}` : null,
		// Only shown when set; absence reads as "native to the graph" (#426).
		person.source_url ? `source: ${person.source_url}` : null,
		person.hot ? "hot" : null,
		person.archived ? "archived" : null,
	].filter(Boolean);
	return `• [${person.id}] ${parts.join(" | ")}\n  tags: ${person.tags?.length ? person.tags.join(", ") : "(none)"}`;
}

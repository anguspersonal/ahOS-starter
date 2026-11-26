import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { PeopleRepository, PersonRow } from "../../ports/people.js";
import { matchesPersonQuery, PEOPLE_SCAN_LIMIT } from "./shared.js";
import { type MatchCandidateArgs, scoreCandidate } from "./scoring.js";

export const PERSON_MATCH_DESCRIPTION =
	"Rank candidate people rows for a source person using name plus optional email, organization, role, and relationship clues.";

const matchCandidateObjectSchema = z.object({
	name: z.string().min(1).describe("Name to match."),
	email: z.string().email().optional().describe("Optional email address from the source."),
	organization: z.string().optional().describe("Optional organization from the source."),
	role: z.string().optional().describe("Optional role from the source."),
	relationship: z.string().optional().describe("Optional relationship from the source."),
});

export const peopleMatchInput = {
	name: z.string().min(1).optional().describe("Name to match (required unless `candidates` is provided)."),
	email: z.string().email().optional().describe("Optional email address from the source."),
	organization: z.string().optional().describe("Optional organization from the source."),
	role: z.string().optional().describe("Optional role from the source."),
	relationship: z.string().optional().describe("Optional relationship from the source."),
	candidates: z
		.array(z.union([matchCandidateObjectSchema, z.string().min(1)]))
		.min(1)
		.max(20)
		.optional()
		.describe(
			"Batch of 1\u201320 candidates to match in a single query. Each item may be a candidate object ({ name, email?, organization?, role?, relationship? }) or a name string.",
		),
	limit: z.number().int().min(1).max(20).optional().describe("Max candidates to return (default 5)."),
	include_archived: z.boolean().optional().describe("Include archived rows. Defaults to false."),
} as const;

export const peopleMatchSchema = z.object(peopleMatchInput);
export type PersonMatchInput = z.infer<typeof peopleMatchSchema>;
export type PersonMatchVerdict = "exact or near-exact match" | "probable match" | "possible match";

export interface ScoredPersonCandidate {
	person: PersonRow;
	score: number;
	reasons: string[];
}

export interface PersonMatchSection {
	query: MatchCandidateArgs;
	verdict: PersonMatchVerdict | null;
	totalMatched: number;
	candidates: ScoredPersonCandidate[];
}

export interface PersonMatchResult {
	mode: "single" | "batch";
	sections: PersonMatchSection[];
	truncated: boolean;
}

function rankCandidates(query: MatchCandidateArgs, matchedRows: PersonRow[], limit: number): PersonMatchSection {
	const scored = matchedRows
		.map((person) => ({ person, ...scoreCandidate(person, query) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
	const best = scored[0];
	const verdict: PersonMatchVerdict | null = !best
		? null
		: best.score >= 90
			? "exact or near-exact match"
			: best.score >= 60
				? "probable match"
				: "possible match";
	return { query, verdict, totalMatched: matchedRows.length, candidates: scored };
}

function formatSection(section: PersonMatchSection): string {
	if (section.candidates.length === 0 || !section.verdict) return "No candidates found.";
	const best = section.candidates[0];
	const body = section.candidates
		.map(
			({ person, score, reasons }) =>
				`\u2022 [${person.id}] ${person.name ?? "(unnamed)"} | score ${score}\n  ${reasons.length ? reasons.join(", ") : "no strong signals"}`,
		)
		.join("\n");
	return (
		`Match result: ${section.verdict}\n` +
		`Best candidate: [${best.person.id}] ${best.person.name ?? "(unnamed)"}\n` +
		`Candidates (showing ${section.candidates.length} of ${section.totalMatched} matched):\n${body}`
	);
}

export function formatPersonMatchMcp(result: PersonMatchResult): string {
	const note = result.truncated
		? `\n\u26a0\ufe0f Scanned the ${PEOPLE_SCAN_LIMIT} most recently updated people only \u2014 other candidates may exist beyond that window.`
		: "";
	if (result.mode === "batch") {
		const rendered = result.sections.map((s) => `### ${s.query.name}\n${formatSection(s)}`).join("\n\n");
		return `${rendered}${note}`;
	}
	const first = result.sections[0];
	return `${first ? formatSection(first) : "No candidates found."}${note}`;
}

export function createPersonMatchAction(
	repo: PeopleRepository,
): ActionDefinition<typeof peopleMatchSchema, PersonMatchResult> {
	return defineAction({
		id: "person_match",
		description: PERSON_MATCH_DESCRIPTION,
		schema: peopleMatchSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		run: async (input: PersonMatchInput, ctx) => {
			const maxPerCandidate = input.limit ?? 5;
			if (input.candidates && input.candidates.length > 0) {
				const { rows: allRows, truncated } = await repo.load(
					{ include_archived: input.include_archived, limit: PEOPLE_SCAN_LIMIT },
					ctx?.userId,
				);
				const sections = input.candidates.map((raw) => {
					const cand: MatchCandidateArgs = typeof raw === "string" ? { name: raw } : raw;
					const matched = allRows.filter((p) => matchesPersonQuery(p, cand.name.toLowerCase()));
					return rankCandidates(cand, matched, maxPerCandidate);
				});
				return { mode: "batch", sections, truncated };
			}
			if (!input.name) {
				throw new Error("People match failed: provide `name` or `candidates`.");
			}
			const { rows: candidates, truncated } = await repo.load(
				{ query: input.name, include_archived: input.include_archived, limit: PEOPLE_SCAN_LIMIT },
				ctx?.userId,
			);
			const query: MatchCandidateArgs = {
				name: input.name,
				email: input.email,
				organization: input.organization,
				role: input.role,
				relationship: input.relationship,
			};
			return { mode: "single", sections: [rankCandidates(query, candidates, maxPerCandidate)], truncated };
		},
		formatMcp: formatPersonMatchMcp,
	});
}

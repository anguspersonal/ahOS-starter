import { collectAliases } from "../../domain/aliases.js";
import type { PersonRow } from "../../ports/people.js";
import { collectPreviousEmails, normalizePersonText, relationshipsMatch } from "./shared.js";

export type MatchCandidateArgs = {
	name: string;
	email?: string;
	organization?: string;
	role?: string;
	relationship?: string;
};

export function scoreCandidate(
	person: PersonRow,
	args: MatchCandidateArgs,
): { score: number; reasons: string[] } {
	let score = 0;
	const reasons: string[] = [];
	const normArgsName = normalizePersonText(args.name);
	const normPersonName = person.name ? normalizePersonText(person.name) : "";
	const exactName =
		person.name?.toLowerCase() === args.name.toLowerCase() ||
		(Boolean(normPersonName) && normPersonName === normArgsName);
	const nameContains = Boolean(
		person.name?.toLowerCase().includes(args.name.toLowerCase()) ||
			(normPersonName && normPersonName.includes(normArgsName)),
	);

	// Aliases score like the name (#1023), counted only when the canonical name did not score.
	const needle = args.name.toLowerCase();
	const rawAliases = collectAliases(person);
	const aliases = rawAliases.map((alias) => alias.toLowerCase());
	const normAliases = rawAliases.map((alias) => normalizePersonText(alias));
	const exactAlias =
		aliases.some((alias) => alias === needle) || normAliases.some((alias) => alias === normArgsName);
	const aliasContains =
		aliases.some((alias) => alias.includes(needle)) ||
		normAliases.some((alias) => alias.includes(normArgsName));

	if (exactName) {
		score += 60;
		reasons.push("exact name match");
	} else if (exactAlias) {
		score += 60;
		reasons.push("exact alias match");
	} else if (nameContains) {
		score += 35;
		reasons.push("name contains search term");
	} else if (aliasContains) {
		score += 30;
		reasons.push("alias contains search term");
	} else if (relationshipsMatch(person.relationship, args.name)) {
		score += 35;
		reasons.push("relationship synonym match");
	}

	if (args.email && person.email?.toLowerCase() === args.email.toLowerCase()) {
		score += 80;
		reasons.push("exact email match");
	} else if (args.email && collectPreviousEmails(person).includes(args.email.trim().toLowerCase())) {
		score += 65;
		reasons.push("previous email match");
	}
	if (args.organization && person.organization?.toLowerCase().includes(args.organization.toLowerCase())) {
		score += 20;
		reasons.push("organization match");
	}
	if (args.role && person.role?.toLowerCase().includes(args.role.toLowerCase())) {
		score += 15;
		reasons.push("role match");
	}
	if (args.relationship && relationshipsMatch(person.relationship, args.relationship)) {
		score += 25;
		reasons.push("relationship match");
	}
	if (person.archived) {
		score -= 10;
		reasons.push("archived penalty");
	}

	return { score, reasons };
}

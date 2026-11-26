import { DOMAIN_LEGACY_SCOPE, parseDomain } from "../../domain/domains.js";
import type { CapabilityEntityRow, CapabilityRepository } from "../../ports/capabilities.js";

export const KINDS = ["skill", "agent", "command"] as const;
export type CapabilityKind = (typeof KINDS)[number];

export const RUNTIME_SURFACES = ["claude-code", "claude-synced", "api"] as const;
export type RuntimeSurface = (typeof RUNTIME_SURFACES)[number];

export const CLIENT_SURFACES = [
	"chat",
	"cowork",
	"mobile",
	"cursor",
	"ide",
	"terminal",
] as const;
export type ClientSurface = (typeof CLIENT_SURFACES)[number];

export const STORAGE_LOCATIONS = ["kms-db", "kms-repo", "claude", "openai"] as const;
export type StorageLocation = (typeof STORAGE_LOCATIONS)[number];

export const SCOPES = ["global", "personal", "work", "ahLtd"] as const;
export type CapabilityScope = (typeof SCOPES)[number];

export interface CapabilityActionPorts {
	repo: CapabilityRepository;
	bodyHash: (body: string) => string;
}

export type CapProps = {
	kind: string[];
	surface: string[];
	clients: string[];
	scope: string | null;
	storage_location: string;
	storage_url: string | null;
	repo_mirror: string | null;
	body: string | null;
	body_synced_at: string | null;
};

export function readCapabilityProps(row: CapabilityEntityRow): CapProps {
	const p = row.properties ?? {};

	let kind: string[] = [];
	if (Array.isArray(p.kind)) {
		kind = p.kind as string[];
	} else if (typeof p.kind === "string" && p.kind.trim() !== "") {
		kind = [p.kind];
	}

	let scope: string | null = typeof p.scope === "string" ? p.scope : null;
	if (!scope && Array.isArray(row.tags)) {
		const scopeTag = row.tags.find((t) => t.startsWith("scope:"));
		if (scopeTag) {
			scope = scopeTag.slice("scope:".length);
		}
	}

	return {
		kind,
		surface: Array.isArray(p.surface) ? (p.surface as string[]) : [],
		clients: Array.isArray(p.clients) ? (p.clients as string[]) : [],
		scope,
		storage_location: typeof p.storage_location === "string" ? p.storage_location : "?",
		storage_url: typeof p.storage_url === "string" ? p.storage_url : null,
		repo_mirror: typeof p.repo_mirror === "string" && p.repo_mirror.trim() !== "" ? p.repo_mirror : null,
		body: typeof p.body === "string" ? p.body : null,
		body_synced_at: typeof p.body_synced_at === "string" ? p.body_synced_at : null,
	};
}

const RITUAL_ALIAS_CANDIDATES: Record<string, readonly string[]> = {
	sync: ["sync", "dos", "synth"],
	synth: ["sync", "dos", "synth"],
	dos: ["sync", "dos", "synth"],
	reflect: ["reflect", "dos-reflect"],
	"dos-reflect": ["reflect", "dos-reflect"],
	prep: ["prep", "prep-day-unattended"],
	"prep-day-unattended": ["prep", "prep-day-unattended"],
	"groom-issues": ["groom-issues", "unblock"],
	unblock: ["groom-issues", "unblock"],
};

/**
 * Strip optional `ahos/` or `ahkms/` namespace prefix (case-insensitive) and
 * return the normalized lowercase needle along with ordered alias candidates
 * for the three canonical rituals (`prep`, `sync`/`synth`/`dos`, `reflect`/`dos-reflect`; ADR-112)
 * and skill aliases (`groom-issues`/`unblock`).
 */
export function normalizeCapabilityLookup(rawName: string): {
	stripped: string;
	candidates: readonly string[];
} {
	const stripped = rawName
		.trim()
		.replace(/^(?:ahos|ahkms)\//i, "")
		.trim()
		.toLowerCase();
	const candidates = RITUAL_ALIAS_CANDIDATES[stripped] ?? [stripped];
	return { stripped, candidates };
}

export function matchCapabilityRows<T extends { title: string | null }>(
	rows: T[],
	candidates: readonly string[],
): T[] {
	for (const candidate of candidates) {
		const matched = rows.filter((row) => (row.title ?? "").toLowerCase() === candidate);
		if (matched.length > 0) return matched;
	}
	return [];
}

/**
 * Classic Levenshtein edit distance.
 */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

/**
 * Find close capability title suggestions when an exact name match misses (#1747).
 * Matches if edit distance <= 2 or relative distance <= 0.3.
 */
export function findSuggestions(needle: string, candidates: CapabilityEntityRow[]): string[] {
	const trimmed = needle.trim().toLowerCase();
	if (trimmed.length === 0) return [];

	type Match = {
		title: string;
		dist: number;
		relative: number;
	};

	const matches: Match[] = [];
	const seen = new Set<string>();

	for (const row of candidates) {
		const title = row.title;
		if (!title) continue;
		const lowerTitle = title.toLowerCase();
		if (seen.has(lowerTitle)) continue;
		seen.add(lowerTitle);

		const dist = levenshtein(trimmed, lowerTitle);
		const maxLen = Math.max(trimmed.length, lowerTitle.length);
		const relative = maxLen > 0 ? dist / maxLen : 0;

		if (dist <= 2 || relative <= 0.3) {
			matches.push({ title, dist, relative });
		}
	}

	matches.sort((a, b) => {
		if (a.dist !== b.dist) return a.dist - b.dist;
		if (a.relative !== b.relative) return a.relative - b.relative;
		return a.title.localeCompare(b.title);
	});

	return matches.map((m) => m.title);
}

const MODE_SIBLING_PREFIXES = ["check-", "verify-"] as const;

/**
 * Find close capability title collisions or `check-<x>` / `verify-<x>` mode-siblings
 * when registering a new capability name.
 */
export function findRegistrationConflicts(needle: string, candidates: CapabilityEntityRow[]): string[] {
	const trimmed = needle.trim().toLowerCase();
	if (trimmed.length === 0) return [];

	const results: string[] = [];
	const seen = new Set<string>([trimmed]);

	const add = (title: string) => {
		const lower = title.toLowerCase();
		if (seen.has(lower)) return;
		seen.add(lower);
		results.push(title);
	};

	const strippedBase = MODE_SIBLING_PREFIXES.reduce(
		(acc, prefix) => (acc.startsWith(prefix) ? acc.slice(prefix.length) : acc),
		trimmed,
	);

	for (const row of candidates) {
		const title = row.title;
		if (!title) continue;
		const lowerTitle = title.toLowerCase();
		const isModeSibling =
			(strippedBase !== trimmed &&
				(lowerTitle === strippedBase ||
					(strippedBase.length > 0 &&
						MODE_SIBLING_PREFIXES.some((prefix) => lowerTitle === `${prefix}${strippedBase}`)))) ||
			MODE_SIBLING_PREFIXES.some((prefix) => lowerTitle === `${prefix}${trimmed}`);
		const isSubstringMatch =
			trimmed.length >= 4 &&
			lowerTitle.length >= 4 &&
			(lowerTitle.includes(trimmed) || trimmed.includes(lowerTitle));
		if (isModeSibling || isSubstringMatch) {
			add(title);
		}
	}

	for (const suggestion of findSuggestions(trimmed, candidates)) {
		add(suggestion);
	}

	return results;
}

/**
 * Resolve a capability's `scope` from either `scope` directly or `domain`
 * (#1062 compatibility). Disagreement is a REFUSAL, not a precedence rule.
 */
export function reconcileCapabilityScope(
	domain: string | undefined,
	scope: string | undefined,
): string | undefined {
	if (domain === undefined || domain === "") return scope || undefined;
	const domainScope = DOMAIN_LEGACY_SCOPE[parseDomain(domain)];
	if (scope !== undefined && scope !== "" && scope !== domainScope) {
		throw new Error(
			`\`domain: '${domain}'\` (scope '${domainScope}') and \`scope: '${scope}'\` disagree. ` +
				`Pass one, or make them agree.`,
		);
	}
	return scope || domainScope;
}

const BUNDLE_POINTER_PREFIX = "> **This file travels with its supporting files carried below.**";

/**
 * Wraps a capability body at serve time (ADR-031 / #810).
 *
 * If `storageLocation === 'kms-db'`, the stored body is authoritative and returned unchanged.
 * For any other storage location, prepends the snapshot preamble. If the body already carries
 * a bundle pointer (#728), merges with it into a single header block.
 */
export function wrapServedCapabilityBody(
	body: string,
	storageLocation: string,
	storageUrl: string | null,
): string {
	if (storageLocation === "kms-db") {
		return body;
	}

	const safeStorageUrl = (storageUrl ?? "(unknown)").replace(/`/g, "'");

	const snapshotNotice =
		`> ⚠ SNAPSHOT. Canonical home: \`${storageLocation}\` at \`${safeStorageUrl}\`. ` +
		"This copy is served for execution only; editing it changes nothing and is lost on the next sync. " +
		"If this protocol is wrong: do not fix it here. File a GitHub issue against the home repo, " +
		"label `skills`, quoting the failing step and what you did instead, then continue the run.";

	const normalized = body.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");

	let frontmatter: string | null = null;
	let restLines: string[] = [...lines];

	if (lines[0] === "---") {
		let closeIndex = -1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i] === "---") {
				closeIndex = i;
				break;
			}
		}
		if (closeIndex !== -1) {
			frontmatter = lines.slice(0, closeIndex + 1).join("\n");
			restLines = lines.slice(closeIndex + 1);
		}
	}

	while (restLines.length > 0 && restLines[0].trim() === "") {
		restLines.shift();
	}

	const bundlePointerLines: string[] = [];
	if (restLines.length > 0 && restLines[0].startsWith(BUNDLE_POINTER_PREFIX)) {
		while (restLines.length > 0 && (restLines[0].startsWith(">") || restLines[0].trim() === "")) {
			if (restLines[0].trim() === "") {
				restLines.shift();
				break;
			}
			bundlePointerLines.push(restLines.shift()!);
		}
	}

	while (restLines.length > 0 && restLines[0].trim() === "") {
		restLines.shift();
	}

	const headerLines: string[] = [snapshotNotice];
	if (bundlePointerLines.length > 0) {
		headerLines.push(">");
		headerLines.push(...bundlePointerLines);
	}

	const headerBlock = headerLines.join("\n");
	const restText = restLines.join("\n");

	if (frontmatter !== null) {
		return restText.length > 0
			? `${frontmatter}\n\n${headerBlock}\n\n${restText}`
			: `${frontmatter}\n\n${headerBlock}`;
	}

	return restText.length > 0 ? `${headerBlock}\n\n${restText}` : headerBlock;
}

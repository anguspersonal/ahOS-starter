import { type AhkmsCapability, fetchCapabilitiesByName } from "./ahkmsSource.js";
import { isSkillCapability, normalizeDeclaredSurface } from "./capabilityShape.js";
import { hashBody } from "./hash.js";
import { type RepoSkillEntry, manifestPath, readManifest, travellingPaths } from "./repoManifest.js";
import { type RepoSkill, defaultRepoRoot, listRepoSkills, repoSkillsDir, resolveSkillBody } from "./repoSkills.js";
import type { SkillBodyResult } from "./skillBody.js";

// Live verification for repo-resident skills (#689): does ahkms actually serve
// the bytes this repo committed?
//
// This is the half that scripts/check-skill-bodies.js CANNOT do. That guard runs
// in CI with no credentials, so it can only prove the working tree matches the
// committed receipt. Only a credentialed read can prove the registry matches
// either of them — an out-of-band edit to the row (a hand-run
// capability_register, say) is invisible to the offline guard by construction.
// Run this after any live push, and whenever the registry is in doubt.
//
// Read-only. Never writes to ahkms or the manifest.

export type RepoSkillStatusKind =
	| "in-sync" // ahkms body hashes equal to the body this repo would serve
	| "registry-stale" // registered, but the body is older/different bytes
	| "no-body" // registered and hosted, serving nothing — the #689 bug
	| "unregistered" // enrolled here, absent from the registry
	| "other-kind" // the name is held by an agent/command, not a skill
	| "not-enrolled" // declared register: false — reported, never compared
	| "missing-file" // the manifest names a skill the repo does not have
	| "body-unbuildable"; // a declared travelling file is missing/unreadable/oversize (#697)

export interface RepoSkillStatus {
	name: string;
	status: RepoSkillStatusKind;
	detail?: string;
}

export interface RepoStatusReport {
	manifestFile: string;
	skills: RepoSkillStatus[];
	/** Repo skills with a SKILL.md that the manifest never declares. */
	undeclared: string[];
}

/** PURE classification of one enrolled skill against its registry row. */
export function statusForRepoSkill(
	name: string,
	entry: RepoSkillEntry,
	skill: RepoSkill | undefined,
	cap: AhkmsCapability | undefined,
	resolved: SkillBodyResult | undefined,
): RepoSkillStatus {
	if (!entry.register) return { name, status: "not-enrolled", detail: entry.why };
	if (!skill) return { name, status: "missing-file", detail: "declared in the manifest, no SKILL.md in .claude/skills/" };
	// Before anything about the registry: if the repo cannot build a body, there is
	// nothing to compare and the skill cannot travel at all. Named, never skipped.
	if (!resolved || !resolved.ok) {
		return { name, status: "body-unbuildable", detail: resolved ? resolved.reason : "body was not resolved" };
	}
	if (!cap) return { name, status: "unregistered", detail: "enrolled for a kms-db body, not in the registry" };
	if (!isSkillCapability(cap)) return { name, status: "other-kind", detail: `registered as ${cap.kind}` };

	if (cap.body === null || cap.body.trim() === "") {
		return { name, status: "no-body", detail: `${cap.storageLocation}, no body — surfaces improvise from the description (#689)` };
	}
	if (hashBody(cap.body) !== resolved.hash) {
		const source = resolved.carried.length > 0 ? `SKILL.md + ${resolved.carried.join(", ")}` : "SKILL.md";
		return {
			name,
			status: "registry-stale",
			detail: `registry body differs from ${source}${cap.bodySyncedAt ? ` (last synced ${cap.bodySyncedAt})` : ""}`,
		};
	}
	// Compare in migration 114's shape: the manifest still declares client names
	// ('cowork', 'chat') that the registry now splits into surface + clients, and a
	// row the migration never rewrote may still hold them too. Normalise both sides.
	const surfaceDrift =
		normalizeDeclaredSurface(entry.surface ?? []).surface.join("+") !== normalizeDeclaredSurface(cap.surface).surface.join("+");
	return {
		name,
		status: "in-sync",
		detail: surfaceDrift ? `body matches; surface differs (registry: ${cap.surface.join("+") || "none"})` : undefined,
	};
}

export async function computeRepoStatus(repoRoot: string = defaultRepoRoot()): Promise<RepoStatusReport> {
	const file = manifestPath(repoRoot);
	const manifest = readManifest(file);
	const skills = new Map(listRepoSkills(repoSkillsDir(repoRoot)).map((skill) => [skill.name, skill]));
	const caps = await fetchCapabilitiesByName();

	const statuses = Object.entries(manifest.skills)
		.map(([name, entry]) => {
			const skill = skills.get(name);
			// Read-only, dev-time status: this does NOT re-check declared vs. actual
			// files on disk (that gate is CI's `supporting-files-changed` violation
			// and repoPush.ts's checkPushPreconditions). Against a mid-edit working
			// tree with an undeclared file, the "present but not carried" block this
			// resolves into would read as "reviewed as not needed" for a file that
			// was never reviewed — harmless here since nothing is written, but worth
			// a guard if this report ever becomes more than a local sanity check.
			const resolved = skill && entry.register ? resolveSkillBody(skill, travellingPaths(entry)) : undefined;
			return statusForRepoSkill(name, entry, skill, caps.get(name.toLowerCase()), resolved);
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	return {
		manifestFile: file,
		skills: statuses,
		undeclared: [...skills.keys()].filter((name) => !(name in manifest.skills)).sort(),
	};
}

const ORDER: RepoSkillStatusKind[] = [
	"no-body",
	"registry-stale",
	"body-unbuildable",
	"unregistered",
	"other-kind",
	"missing-file",
	"in-sync",
	"not-enrolled",
];

const LABEL: Record<RepoSkillStatusKind, string> = {
	"no-body": "HOSTED BUT EMPTY (register a body)",
	"registry-stale": "REGISTRY STALE (re-push)",
	"body-unbuildable": "CANNOT TRAVEL (no body can be assembled)",
	unregistered: "UNREGISTERED (enrolled, never pushed)",
	"other-kind": "name held by an agent/command",
	"missing-file": "MANIFEST STALE (no such skill)",
	"in-sync": "in sync",
	"not-enrolled": "not enrolled (register: false)",
};

/** True when anything actionable is wrong — drives the CLI exit code. */
export function repoStatusHasProblems(report: RepoStatusReport): boolean {
	const bad = new Set<RepoSkillStatusKind>([
		"no-body",
		"registry-stale",
		"body-unbuildable",
		"unregistered",
		"other-kind",
		"missing-file",
	]);
	return report.undeclared.length > 0 || report.skills.some((skill) => bad.has(skill.status));
}

export function formatRepoStatus(report: RepoStatusReport): string {
	const lines: string[] = [`skill-sync repo status — ${report.manifestFile}`, ""];
	for (const kind of ORDER) {
		const bucket = report.skills.filter((skill) => skill.status === kind);
		if (bucket.length === 0) continue;
		lines.push(`${LABEL[kind]} (${bucket.length}):`);
		for (const skill of bucket) lines.push(`  • ${skill.name}${skill.detail ? `  — ${skill.detail}` : ""}`);
		lines.push("");
	}
	if (report.undeclared.length > 0) {
		lines.push(`UNDECLARED — a SKILL.md the manifest never mentions (${report.undeclared.length}):`);
		for (const name of report.undeclared) lines.push(`  • ${name}`);
		lines.push("");
	}
	lines.push(`${report.skills.length} declared skill(s).`);
	return lines.join("\n");
}

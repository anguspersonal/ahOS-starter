import { type AhkmsCapability, fetchAllCapabilities } from "./ahkmsSource.js";
import { isSkillCapability } from "./capabilityShape.js";
import { hashBody } from "./hash.js";
import { defaultSkillsHome, listLocalSkills, type LocalSkill } from "./localSkills.js";
import { hasSupportingFilesDecl, resolveMultiFileBody } from "./push.js";
import { classify, type ReconcileState } from "./reconcile.js";
import { getBaseHash, readSyncState } from "./syncState.js";

// The read-only status pass (#370). Wires the pure core (tier/hash/reconcile/state)
// to the ahkms read side and reports, per single-file skill, which reconcile row it
// is in — WITHOUT mutating any skill file, ahkms, or the sync-state.

export type StatusKind =
	| ReconcileState
	| "multi-file" // excluded from the reconcile loop (local-authoritative)
	| "other-kind" // name registered in ahkms, but as an agent/command — not a skill (#381)
	| "local-only"; // single-file and not registered under this name in ahkms at all

export interface SkillStatus {
	name: string;
	tier: "single" | "multi";
	isSymlink: boolean;
	status: StatusKind;
	/** Human-readable extra context (e.g. "indexed, no body"; "compare-only"). */
	detail?: string;
}

export interface StatusReport {
	skillsHome: string;
	skills: SkillStatus[];
}

/**
 * Classify one local skill against its same-named ahkms capability (of ANY kind)
 * and the recorded merge base. No network/env — so it is exhaustively
 * unit-testable against fabricated `LocalSkill`/`cap` fixtures without a live
 * ahkms. `cap` is looked up by name across kinds: an agent/command that
 * shares a skill-dir's name is reported as agent-backed ("other-kind"), NOT as an
 * unregistered skill (#381).
 *
 * A `tier: "multi"` skill reads its own directory (via `resolveMultiFileBody`)
 * ONLY when it declares a `supporting_files` manifest — the same condition
 * `pushSkill` uses to decide whether it's pushed at all (#758). A fabricated
 * skill with no real files on disk and no manifest is unaffected: the read is
 * a no-op `existsSync` miss, and the classification stays the blanket
 * "multi-file" bucket it always was.
 */
export function statusForSkill(skill: LocalSkill, cap: AhkmsCapability | undefined, baseHash: string | null): SkillStatus {
	if (skill.tier === "multi") {
		// A multi-file skill with no supporting_files manifest is genuinely
		// local-authoritative — unchanged, blanket "multi-file" bucket.
		if (!hasSupportingFilesDecl(skill)) {
			return { name: skill.name, tier: "multi", isSymlink: skill.isSymlink, status: "multi-file" };
		}

		// A manifest is declared, so this skill IS pushed to kms-db (push.ts) —
		// run it through the same single-file-style reconcile classification
		// against its ASSEMBLED body, instead of the blanket bucket (round 1 QA
		// High finding: the old blanket classification made drift on these
		// skills undetectable once they were enrolled).
		const resolved = resolveMultiFileBody(skill);
		if (!resolved.ok) {
			return {
				name: skill.name,
				tier: "multi",
				isSymlink: skill.isSymlink,
				status: "multi-file",
				detail: `manifest declared but could not be assembled: ${resolved.reason}`,
			};
		}

		const details: string[] = [];
		if (skill.isSymlink) details.push("compare-only (symlink)");

		let status: StatusKind;
		if (!cap) {
			status = "local-only";
		} else if (!isSkillCapability(cap)) {
			status = "other-kind";
			details.push(`registered as ${cap.kind}`);
		} else {
			const localHash = hashBody(resolved.body);
			const ahkmsHash = cap.body !== null ? hashBody(cap.body) : null;
			if (ahkmsHash === null) details.push(`${cap.storageLocation}, no body`);
			status = classify({ local: localHash, ahkms: ahkmsHash, base: baseHash });
		}

		return {
			name: skill.name,
			tier: "multi",
			isSymlink: skill.isSymlink,
			status,
			detail: details.length > 0 ? details.join("; ") : undefined,
		};
	}

	const details: string[] = [];
	if (skill.isSymlink) details.push("compare-only (symlink)");

	let status: StatusKind;
	if (!cap) {
		status = "local-only";
	} else if (!isSkillCapability(cap)) {
		// Registered under this name, but as an agent/command — a legit dual setup,
		// not an unregistered skill. Don't run the body reconcile against it.
		status = "other-kind";
		details.push(`registered as ${cap.kind}`);
	} else {
		const localHash = hashBody(skill.skillMd ?? "");
		const ahkmsHash = cap.body !== null ? hashBody(cap.body) : null;
		if (ahkmsHash === null) details.push(`${cap.storageLocation}, no body`);
		status = classify({ local: localHash, ahkms: ahkmsHash, base: baseHash });
	}

	return {
		name: skill.name,
		tier: "single",
		isSymlink: skill.isSymlink,
		status,
		detail: details.length > 0 ? details.join("; ") : undefined,
	};
}

export async function computeStatus(skillsHome: string = defaultSkillsHome()): Promise<StatusReport> {
	const locals = listLocalSkills(skillsHome);
	const state = readSyncState(skillsHome);
	const caps = await fetchAllCapabilities();

	const skills = locals.map((skill) =>
		statusForSkill(skill, caps.get(skill.name.toLowerCase()), getBaseHash(state, skill.name)),
	);

	return { skillsHome, skills };
}

// Presentation. Group by actionability so the interesting rows surface first.
const ORDER: StatusKind[] = [
	"conflict",
	"no-base",
	"ahkms-moved",
	"local-moved",
	"converged",
	"ahkms-missing",
	"local-only",
	"in-sync",
	"other-kind",
	"multi-file",
];

const LABEL: Record<StatusKind, string> = {
	conflict: "CONFLICT (both changed — resolve)",
	"no-base": "NO BASE (never synced, diverged)",
	"ahkms-moved": "ahkms moved (pull)",
	"local-moved": "local moved (push)",
	converged: "converged (advance base)",
	"ahkms-missing": "ahkms has no body",
	"local-only": "local only (unregistered)",
	"in-sync": "in sync",
	"other-kind": "registered as agent/command (not a skill)",
	"multi-file": "multi-file (local-authoritative)",
};

export function formatStatus(report: StatusReport): string {
	const lines: string[] = [`skill-sync status — ${report.skillsHome}`, ""];
	const byStatus = new Map<StatusKind, SkillStatus[]>();
	for (const skill of report.skills) {
		const bucket = byStatus.get(skill.status) ?? [];
		bucket.push(skill);
		byStatus.set(skill.status, bucket);
	}

	for (const kind of ORDER) {
		const bucket = byStatus.get(kind);
		if (!bucket || bucket.length === 0) continue;
		lines.push(`${LABEL[kind]} (${bucket.length}):`);
		for (const skill of bucket.sort((a, b) => a.name.localeCompare(b.name))) {
			lines.push(`  • ${skill.name}${skill.detail ? `  — ${skill.detail}` : ""}`);
		}
		lines.push("");
	}

	lines.push(`${report.skills.length} skills total.`);
	return lines.join("\n");
}

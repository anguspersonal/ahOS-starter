import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchSkillCapabilities } from "./ahkmsSource.js";
import { hashBody } from "./hash.js";
import { defaultSkillsHome, listLocalSkills, type LocalSkill } from "./localSkills.js";
import { hasSupportingFilesDecl, resolveMultiFileBody } from "./push.js";
import { setBase } from "./syncState.js";

// Pull a single skill's ahkms body down over the local SKILL.md (ADR: ahkms as
// source of truth for single-file skills, extended to user-level multi-file
// skills with a supporting_files manifest — Issue #758). This is the "ahkms
// moved, local didn't" resolver, exposed as a deliberate manual command: it
// ALWAYS backs the local file up first, so even a force-pull over local edits
// stays recoverable. Symlinked skills are compare-only — never written through
// the link. A manifest-declared multi-file skill's ahkms body is an ASSEMBLED
// bundle, not literal SKILL.md content, so it is compare-only too: drift is
// flagged ("warned"), never auto-applied — see the tier==="multi" branch below.

export interface PullResult {
	name: string;
	outcome: "pulled" | "skipped" | "warned";
	reason?: string;
	/** Where the pre-overwrite copy was written, when an overwrite happened. */
	backupPath?: string;
}

/** Predictable, gitignored location for a pre-overwrite backup of a skill's SKILL.md. */
export function backupPath(skillsHome: string, name: string, stamp: string): string {
	return join(skillsHome, ".sync-backups", name, `${stamp}.SKILL.md`);
}

/** Filesystem-safe timestamp for backup filenames (colons/dots break some tools). */
function stampNow(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Reconcile one skill toward the ahkms body. `ahkmsBody` is the authoritative
 * kms-db body (null when ahkms has none, e.g. an indexed skill). Pure of network —
 * the caller fetches the body — so this is straightforward to unit-test.
 */
export function pullSkill(skill: LocalSkill, skillsHome: string, ahkmsBody: string | null): PullResult {
	// A multi-file skill with no supporting_files manifest is never pushed at
	// all — genuinely local-authoritative, unchanged.
	if (skill.tier === "multi" && !hasSupportingFilesDecl(skill)) {
		return { name: skill.name, outcome: "skipped", reason: "multi-file (local-authoritative)" };
	}
	if (ahkmsBody === null) {
		return { name: skill.name, outcome: "skipped", reason: "no ahkms body to pull" };
	}

	let localHash: string | null;
	if (skill.tier === "multi") {
		const resolved = resolveMultiFileBody(skill);
		if (!resolved.ok) {
			return { name: skill.name, outcome: "skipped", reason: resolved.reason };
		}
		localHash = hashBody(resolved.body);
	} else {
		localHash = skill.skillMd === null ? null : hashBody(skill.skillMd);
	}
	const ahkmsHash = hashBody(ahkmsBody);

	// Compare-only: a symlinked skill points into another tree; never write through it.
	if (skill.isSymlink) {
		if (localHash !== ahkmsHash) {
			return {
				name: skill.name,
				outcome: "warned",
				reason: "symlinked — ahkms differs but won't overwrite through the symlink",
			};
		}
		return { name: skill.name, outcome: "skipped", reason: "symlinked and already in sync" };
	}

	if (localHash === ahkmsHash) {
		// Already equal; just make sure the base records it so status reads in-sync.
		setBase(skillsHome, skill.name, ahkmsHash, new Date().toISOString(), ahkmsBody);
		return { name: skill.name, outcome: "skipped", reason: "already in sync" };
	}

	// A multi-file skill's ahkms body is an ASSEMBLED bundle (SKILL.md plus
	// carried supporting files, fenced together — skillBody.ts), not literal
	// SKILL.md content. Writing it verbatim into SKILL.md would corrupt the
	// file and silently drop the supporting files it carries, so these are
	// never auto-overwritten — flag the drift instead (round 1 QA High finding).
	if (skill.tier === "multi") {
		return {
			name: skill.name,
			outcome: "warned",
			reason: "ahkms body differs from the assembled local body — multi-file skills are not auto-pulled; reconcile the supporting files by hand, then re-push",
		};
	}

	// Back the current local file up BEFORE overwriting, then write ahkms's body.
	const backup = backupPath(skillsHome, skill.name, stampNow());
	mkdirSync(dirname(backup), { recursive: true });
	writeFileSync(backup, skill.skillMd ?? "", "utf8");

	writeFileSync(join(skill.realDir, "SKILL.md"), ahkmsBody, "utf8");
	setBase(skillsHome, skill.name, ahkmsHash, new Date().toISOString(), ahkmsBody);
	return { name: skill.name, outcome: "pulled", backupPath: backup };
}

/** Pull one skill by name: look it up locally, fetch its ahkms body, reconcile. */
export async function pullByName(name: string, skillsHome: string = defaultSkillsHome()): Promise<PullResult> {
	const skill = listLocalSkills(skillsHome).find((s) => s.name === name);
	if (!skill) return { name, outcome: "skipped", reason: "no such local skill" };
	const caps = await fetchSkillCapabilities();
	const cap = caps.get(name.toLowerCase());
	return pullSkill(skill, skillsHome, cap?.body ?? null);
}

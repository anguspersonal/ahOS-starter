import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchAllCapabilities } from "./ahkmsSource.js";
import { readBase } from "./baseCache.js";
import { backupPath, pullSkill } from "./pull.js";
import { pushSkill } from "./push.js";
import { defaultSkillsHome, listLocalSkills } from "./localSkills.js";
import { merge3 } from "./merge3.js";
import { statusForSkill } from "./status.js";
import { getBaseHash, readSyncState } from "./syncState.js";

// `skill-sync resolve` (#374): walk the both-changed ("conflict") rows the
// SessionStart hook (#373) defers — the row `isAutoApplicable` (reconcile.ts)
// deliberately refuses to auto-apply. This module NEVER re-implements that
// classification: `findConflicts` calls the exact same `statusForSkill` the hook
// and `status` use, so "the conflicts resolve enumerates" and "the conflicts the
// hook deferred" are, by construction, the same set.
//
// Every resolving choice (keep-local / keep-ahkms) is applied through the
// EXISTING push/pull primitives — never a second write path — and the base is
// only advanced by those primitives' own success path, so a `skip`, a `merge`
// (which only prepares a file for hand-editing) or a failed write leaves the
// conflict exactly as deferred: no partial write, nothing to lose.

export type ResolveChoice = "keep-local" | "keep-ahkms" | "skip" | "merge";

export interface ConflictInfo {
	name: string;
	local: string;
	ahkms: string;
	/** Recorded base hash — always present for a "conflict" row (reconcile.ts). */
	baseHash: string;
	/** Cached base content, or null when the base predates content-caching (#374). */
	base: string | null;
}

export type ResolveOutcomeKind = "kept-local" | "kept-ahkms" | "skipped" | "merge-pending" | "failed";

export interface ResolveOutcome {
	name: string;
	outcome: ResolveOutcomeKind;
	reason?: string;
	backupPath?: string;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * True when `text` already carries `git merge-file`/`merge3`'s conflict markers
 * (QA round 1, High): re-running `--merge` on a still-marked local file would feed
 * it straight back through `merge3` and nest a second set of markers inside the
 * first. All three marker lines are required so ordinary content that happens to
 * contain one lone `=======`-shaped divider isn't mistaken for a real conflict.
 */
function hasConflictMarkers(text: string): boolean {
	return /^<<<<<<< /m.test(text) && /^=======$/m.test(text) && /^>>>>>>> /m.test(text);
}

/**
 * A `backupPath` for this stamp, suffixed if one already exists (QA round 1,
 * Medium/High: backups must never be silently overwritten by a later `--merge`).
 * `backupPath` itself is already deterministic (same skill + stamp -> same path);
 * this just guarantees a second write under the same stamp gets its own file
 * instead of clobbering the first.
 */
function uniqueBackupPath(skillsHome: string, name: string, stamp: string): string {
	let candidate = backupPath(skillsHome, name, stamp);
	for (let n = 2; existsSync(candidate); n++) {
		candidate = backupPath(skillsHome, name, `${stamp}-${n}`);
	}
	return candidate;
}

/**
 * Enumerate exactly the both-changed rows `status`/the hook would report as
 * "conflict" — single-file skills, registered as a skill in ahkms, with a
 * recorded base, where local and ahkms have each moved away from it to
 * different content. Reuses `statusForSkill` (the same detection `status` and
 * the hook use) rather than re-deriving it.
 */
export async function findConflicts(skillsHome: string = defaultSkillsHome()): Promise<ConflictInfo[]> {
	const locals = listLocalSkills(skillsHome).filter((s) => s.tier === "single");
	const state = readSyncState(skillsHome);
	const caps = await fetchAllCapabilities();

	const conflicts: ConflictInfo[] = [];
	for (const skill of locals) {
		const cap = caps.get(skill.name.toLowerCase());
		const baseHash = getBaseHash(state, skill.name);
		const { status } = statusForSkill(skill, cap, baseHash);
		if (status !== "conflict") continue;
		// classify() only reaches "conflict" when base and ahkms body are both non-null.
		conflicts.push({
			name: skill.name,
			local: skill.skillMd ?? "",
			ahkms: cap?.body ?? "",
			baseHash: baseHash as string,
			base: readBase(skillsHome, baseHash as string),
		});
	}
	return conflicts;
}

/** Unified diff of `a` -> `b`, via the system `diff -u` (no new dependency). */
function unifiedDiff(labelA: string, a: string, labelB: string, b: string): string {
	const dir = mkdtempSync(join(tmpdir(), "skill-resolve-diff-"));
	try {
		const fa = join(dir, "a");
		const fb = join(dir, "b");
		writeFileSync(fa, a, "utf8");
		writeFileSync(fb, b, "utf8");
		try {
			const out = execFileSync("diff", ["-u", "--label", labelA, "--label", labelB, fa, fb], { encoding: "utf8" });
			return out.length > 0 ? out : "(no difference)\n";
		} catch (err) {
			// `diff` exits 1 when the inputs differ (not an error) and still prints to
			// stdout; only a status >1 (or no stdout at all) is a real failure.
			const e = err as { code?: string; status?: number; stdout?: string };
			if (typeof e.status === "number" && e.status === 1 && typeof e.stdout === "string") return e.stdout;
			if (e.code === "ENOENT") {
				// System diff binary not found in PATH (e.g. Windows); fall back to git diff --no-index
				try {
					const out = execFileSync("git", ["diff", "--no-index", `--src-prefix=${labelA}/`, `--dst-prefix=${labelB}/`, fa, fb], { encoding: "utf8" });
					return out.length > 0 ? out : "(no difference)\n";
				} catch (gitErr) {
					const ge = gitErr as { status?: number; stdout?: string };
					if (typeof ge.status === "number" && ge.status === 1 && typeof ge.stdout === "string") return ge.stdout;
					throw gitErr;
				}
			}
			throw err;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Render one conflict as a readable 3-way (base, local, ahkms). */
export function formatConflict(c: ConflictInfo): string {
	const lines = [`conflict: ${c.name}`, ""];
	if (c.base === null) {
		lines.push(
			"(base content not cached — this base predates resolve's content cache; showing local vs ahkms only)",
			unifiedDiff("local", c.local, "ahkms", c.ahkms),
		);
	} else {
		lines.push("--- base -> local ---", unifiedDiff("base", c.base, "local", c.local), "--- base -> ahkms ---", unifiedDiff("base", c.base, "ahkms", c.ahkms));
	}
	return lines.join("\n");
}

/**
 * Apply one resolving choice for one conflict. `skip` and a failed write leave
 * the skill's state file, its local SKILL.md, and its ahkms body all untouched —
 * the conflict remains deferred. `keep-local` / `keep-ahkms` go through
 * `pushSkill` / `pullSkill` exactly as the hook does for the unambiguous rows, so
 * the base only advances on their own success path.
 */
export async function resolveConflict(c: ConflictInfo, choice: ResolveChoice, skillsHome: string = defaultSkillsHome()): Promise<ResolveOutcome> {
	if (choice === "skip") {
		return { name: c.name, outcome: "skipped", reason: "left deferred" };
	}

	const skill = listLocalSkills(skillsHome).find((s) => s.name === c.name);
	if (!skill) return { name: c.name, outcome: "failed", reason: "no such local skill" };

	if (choice === "keep-local") {
		try {
			const r = await pushSkill(skill, skillsHome);
			if (r.outcome === "skipped") return { name: c.name, outcome: "failed", reason: r.reason };
			return { name: c.name, outcome: "kept-local" };
		} catch (err) {
			return { name: c.name, outcome: "failed", reason: errMessage(err) };
		}
	}

	if (choice === "keep-ahkms") {
		const r = pullSkill(skill, skillsHome, c.ahkms);
		if (r.outcome === "warned") return { name: c.name, outcome: "failed", reason: r.reason };
		return { name: c.name, outcome: "kept-ahkms", backupPath: r.backupPath };
	}

	// merge: prepare, don't resolve. Writes a conflict-marked SKILL.md for hand
	// editing (backing the current local file up first, same discipline as
	// pullSkill) and leaves the base untouched — the skill is still "conflict" on
	// the next status/resolve pass until a choice actually advances the base. A
	// hand-edited file that now differs from ahkms is picked up as `local` the
	// next time `resolve` runs, ready for `--keep local`.
	if (skill.isSymlink) {
		return { name: c.name, outcome: "failed", reason: "symlinked — won't write a merge-marked file through the symlink" };
	}
	if (c.base === null) {
		return { name: c.name, outcome: "failed", reason: "no cached base — can't hand-merge; use --keep local or --keep ahkms" };
	}
	if (hasConflictMarkers(c.local)) {
		return {
			name: c.name,
			outcome: "failed",
			reason:
				"local SKILL.md already has unresolved conflict markers from a previous --merge — finish the hand-merge and run 'resolve --keep local', or restore the backup and re-run --merge, before merging again",
		};
	}

	const backup = uniqueBackupPath(skillsHome, c.name, new Date().toISOString().replace(/[:.]/g, "-"));
	mkdirSync(dirname(backup), { recursive: true });
	writeFileSync(backup, c.local, "utf8");

	const { merged, conflicts } = merge3(c.base, c.local, c.ahkms);
	writeFileSync(join(skill.realDir, "SKILL.md"), merged, "utf8");
	return {
		name: c.name,
		outcome: "merge-pending",
		reason: `${conflicts} conflict marker(s) written to ${skill.realDir}/SKILL.md — edit, then re-run resolve --keep local`,
		backupPath: backup,
	};
}

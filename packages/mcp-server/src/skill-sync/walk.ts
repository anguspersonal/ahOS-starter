import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheBase, readBase } from "./baseCache.js";
import { gitBlobHash } from "./gitBlob.js";
import { defaultSkillsHome, listLocalSkills } from "./localSkills.js";
import { merge3 } from "./merge3.js";
import { listUpstreams, readUpstreamBlob, upstreamHead } from "./upstream.js";
import { parseXUpstream, removeXUpstream, stampXUpstream } from "./xUpstream.js";

// The 3-way diff-walk (#376): reconcile upstream updates into an already-mapped fork.
// When upstream HEAD has moved past the fork's recorded base_blob, merge the
// base->HEAD changes into the local fork (which carries its own divergence), then
// advance the x-upstream base to the reviewed HEAD and refresh the base cache.
// Unmoved upstream is a no-op. The first walk after a fresh mapping is the fuzzy case
// (base == HEAD, nothing to show) — reported as "unmoved".

export type WalkOutcome = "unmoved" | "merged" | "conflict" | "no-mapping" | "no-base";

export interface WalkResult {
	name: string;
	outcome: WalkOutcome;
	conflicts?: number;
	/** New base commit after an applied walk. */
	baseCommit?: string;
	reason?: string;
}

/**
 * Walk one mapped fork against its upstream. Read-only unless `opts.apply` — then it
 * writes the merged SKILL.md and advances the base. `reviewedAt` is injected (not read
 * from the clock) so the operation is deterministic and testable.
 */
export function walkFork(
	localSkillName: string,
	reviewedAt: string,
	opts: { apply: boolean },
	skillsHome: string = defaultSkillsHome(),
): WalkResult {
	const local = listLocalSkills(skillsHome).find((s) => s.name === localSkillName);
	if (!local || local.skillMd === null) {
		return { name: localSkillName, outcome: "no-mapping", reason: "no such local skill" };
	}
	const x = parseXUpstream(local.skillMd);
	if (!x) return { name: localSkillName, outcome: "no-mapping", reason: "no x-upstream provenance — map it first" };

	const up = listUpstreams(skillsHome).find((u) => u.url === x.repo);
	if (!up) return { name: localSkillName, outcome: "no-mapping", reason: `upstream ${x.repo} not registered` };

	const upstreamNow = readFileSync(join(up.dir, x.path), "utf8");
	const uBlob = gitBlobHash(upstreamNow);
	if (uBlob === x.baseBlob) return { name: localSkillName, outcome: "unmoved" };

	const base = readBase(skillsHome, x.baseBlob) ?? recoverBaseFromClone(skillsHome, up.dir, x.baseBlob, x.path);
	if (base === null) {
		return {
			name: localSkillName,
			outcome: "no-base",
			reason:
				`base ${x.baseBlob} is neither cached nor in the upstream clone. Re-mapping resets the base to upstream HEAD, ` +
				"which discards every unreviewed upstream change since the old base (they would never reach the merge)",
		};
	}

	const { merged, conflicts } = merge3(base, removeXUpstream(local.skillMd), upstreamNow);

	if (opts.apply) {
		const head = upstreamHead(up.dir);
		const restamped = stampXUpstream(merged, { ...x, baseCommit: head, baseBlob: uBlob, reviewed: reviewedAt });
		writeFileSync(join(local.realDir, "SKILL.md"), restamped, "utf8");
		cacheBase(skillsHome, uBlob, upstreamNow); // so the NEXT walk has this base
		return { name: localSkillName, outcome: conflicts ? "conflict" : "merged", conflicts, baseCommit: head };
	}
	return { name: localSkillName, outcome: conflicts ? "conflict" : "merged", conflicts };
}

/**
 * Forks mapped before the base cache existed have no cached base, but a clone that
 * has not been re-fetched since can still hold the blob. Read it, verify it really
 * is that blob, and cache it so later walks skip git. `baseBlob` was hashed from the
 * working-tree file, so on a CRLF checkout it matches the filtered content, not the
 * raw object; try both.
 */
function recoverBaseFromClone(skillsHome: string, upstreamDir: string, baseBlob: string, path: string): string | null {
	for (const content of [readUpstreamBlob(upstreamDir, baseBlob), readUpstreamBlob(upstreamDir, baseBlob, path)]) {
		if (content !== null && gitBlobHash(content) === baseBlob) {
			cacheBase(skillsHome, baseBlob, content);
			return content;
		}
	}
	return null;
}

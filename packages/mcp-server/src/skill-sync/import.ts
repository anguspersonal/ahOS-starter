import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { cacheBase } from "./baseCache.js";
import { gitBlobHash } from "./gitBlob.js";
import { defaultSkillsHome } from "./localSkills.js";
import { detectTier } from "./tier.js";
import { ADAPTER_DIRS, type Upstream, type UpstreamSkill } from "./upstream.js";
import { stampXUpstream } from "./xUpstream.js";

// Import a new upstream skill into the local skills tree (#375). The upstream's
// agents/ adapter (its OpenAI/plugin distribution manifest) is stripped on import —
// it is redundant with our ahkms cross-surface path and, left in, would make every
// imported skill multi-file. Genuine content (scripts/, referenced docs) is kept, so
// the skill is tiered by its OWN file count. The copied SKILL.md is stamped with
// x-upstream provenance pinned to the reviewed upstream HEAD + blob.

export interface ImportResult {
	name: string;
	dir: string;
	tier: "single" | "multi";
	baseCommit: string;
	baseBlob: string;
}

/**
 * Copy `skill` out of its upstream clone into `<skillsHome>/<name>/`, stripping the
 * adapter dir, then stamp x-upstream. `head` and `reviewedAt` are passed in (not read
 * from the clock/git) so the operation is deterministic and unit-testable. Refuses to
 * clobber an existing local skill of the same name.
 */
export function importUpstreamSkill(
	upstream: Upstream,
	skill: UpstreamSkill,
	head: string,
	reviewedAt: string,
	skillsHome: string = defaultSkillsHome(),
): ImportResult {
	const srcDir = dirname(join(upstream.dir, skill.path));
	const targetDir = join(skillsHome, skill.name);
	if (existsSync(targetDir)) {
		throw new Error(`skill-sync: '${skill.name}' already exists locally — import would clobber it`);
	}

	cpSync(srcDir, targetDir, {
		recursive: true,
		filter: (src) => {
			if (src === srcDir) return true;
			const rel = relative(srcDir, src);
			const top = rel.split(sep)[0];
			if (ADAPTER_DIRS.has(top)) return false; // strip the distribution adapter
			if (basename(src).startsWith(".")) return false; // no dotfiles
			return true;
		},
	});

	const mdPath = join(targetDir, "SKILL.md");
	const body = readFileSync(mdPath, "utf8"); // upstream content, pre-stamp
	const baseBlob = gitBlobHash(body);
	cacheBase(skillsHome, baseBlob, body); // so a later diff-walk can retrieve this base
	writeFileSync(
		mdPath,
		stampXUpstream(body, { repo: upstream.url, path: skill.path, baseCommit: head, baseBlob, reviewed: reviewedAt }),
		"utf8",
	);

	return { name: skill.name, dir: targetDir, tier: detectTier(targetDir).tier, baseCommit: head, baseBlob };
}

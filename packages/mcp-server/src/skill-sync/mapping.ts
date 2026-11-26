import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheBase } from "./baseCache.js";
import { gitBlobHash } from "./gitBlob.js";
import { defaultSkillsHome, listLocalSkills } from "./localSkills.js";
import { type MappingSuggestion, suggestMappings } from "./similarity.js";
import { listUpstreamSkills, type Upstream } from "./upstream.js";
import { stampXUpstream } from "./xUpstream.js";

// Confirmed fork mapping (#375). suggestForkMappings only RANKS candidates; mapFork
// is the write, and calling it IS the human's confirmation. It stamps x-upstream on
// the LOCAL skill, pinning the synthetic base to the current upstream HEAD + blob —
// the "reviewed against HEAD, divergences intentional" fork-point from which #376's
// 3-way diff-walk later works.

/** Rank each upstream skill against the local forks by body similarity (suggestion only). */
export function suggestForkMappings(upstream: Upstream, skillsHome: string = defaultSkillsHome()): MappingSuggestion[] {
	const us = listUpstreamSkills(upstream.dir).map((s) => ({ name: s.name, body: s.body }));
	const ls = listLocalSkills(skillsHome).map((s) => ({ name: s.name, body: s.skillMd ?? "" }));
	return suggestMappings(us, ls);
}

export interface MapResult {
	upstream: string;
	local: string;
	baseCommit: string;
	baseBlob: string;
}

export function mapFork(
	upstream: Upstream,
	upstreamSkillName: string,
	localSkillName: string,
	head: string,
	reviewedAt: string,
	skillsHome: string = defaultSkillsHome(),
): MapResult {
	const uSkill = listUpstreamSkills(upstream.dir).find((s) => s.name === upstreamSkillName);
	if (!uSkill) throw new Error(`skill-sync: upstream skill '${upstreamSkillName}' not found in ${upstream.name}`);
	const local = listLocalSkills(skillsHome).find((s) => s.name === localSkillName);
	if (!local) throw new Error(`skill-sync: local skill '${localSkillName}' not found`);
	if (local.skillMd === null) throw new Error(`skill-sync: local skill '${localSkillName}' has no SKILL.md`);

	const baseBlob = gitBlobHash(uSkill.body);
	cacheBase(skillsHome, baseBlob, uSkill.body); // so a later diff-walk can retrieve this base
	const stamped = stampXUpstream(local.skillMd, {
		repo: upstream.url,
		path: uSkill.path,
		baseCommit: head,
		baseBlob,
		reviewed: reviewedAt,
		localEdits: `mapped to ${upstream.name}:${upstreamSkillName} — fork predates mapping; divergences reviewed`,
	});
	writeFileSync(join(local.realDir, "SKILL.md"), stamped, "utf8");
	return { upstream: upstreamSkillName, local: localSkillName, baseCommit: head, baseBlob };
}

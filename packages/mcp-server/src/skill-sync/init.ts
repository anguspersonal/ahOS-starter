import { fetchSkillCapabilities } from "./ahkmsSource.js";
import { hashBody } from "./hash.js";
import { defaultSkillsHome, listLocalSkills } from "./localSkills.js";
import { getBaseHash, readSyncState, setBase } from "./syncState.js";

// One-time base bootstrap (ADR: ahkms as source of truth for single-file skills).
// For every single-file skill where local == ahkms, record that shared content as
// the merge base, so subsequent status/reconcile passes have something to diff
// against. Where the two sides differ, leave the skill UNBASED — init never guesses
// which side wins; resolve does that. Already-based skills are left untouched.

export interface InitResult {
	name: string;
	outcome: "based" | "unbased" | "skipped";
	reason?: string;
}

export async function initBases(skillsHome: string = defaultSkillsHome()): Promise<InitResult[]> {
	const singles = listLocalSkills(skillsHome).filter((s) => s.tier === "single");
	const caps = await fetchSkillCapabilities();
	const state = readSyncState(skillsHome);
	const results: InitResult[] = [];

	for (const skill of singles) {
		if (getBaseHash(state, skill.name) !== null) {
			results.push({ name: skill.name, outcome: "skipped", reason: "already based" });
			continue;
		}
		const cap = caps.get(skill.name.toLowerCase());
		if (!cap || cap.body === null) {
			results.push({ name: skill.name, outcome: "unbased", reason: "no ahkms body" });
			continue;
		}
		const localHash = skill.skillMd === null ? null : hashBody(skill.skillMd);
		const ahkmsHash = hashBody(cap.body);
		if (localHash === ahkmsHash) {
			setBase(skillsHome, skill.name, ahkmsHash, new Date().toISOString(), cap.body);
			results.push({ name: skill.name, outcome: "based" });
		} else {
			results.push({ name: skill.name, outcome: "unbased", reason: "local differs from ahkms — run resolve" });
		}
	}
	return results;
}

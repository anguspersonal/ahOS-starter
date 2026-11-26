import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectTier, type Tier } from "./tier.js";

// Enumerate the local skills tree (ADR: ahkms as source of truth for single-file
// skills). A skill is a directory under the skills home containing a SKILL.md.
// Some entries are symlinks into another tree (e.g. ~/.agents/skills, the Matt
// Pocock setup); we resolve them for reading but flag them so later slices never
// write THROUGH the symlink (compare-only rule).

export interface LocalSkill {
	name: string;
	/** Path as it appears under the skills home (possibly a symlink). */
	dir: string;
	/** Fully resolved directory the symlink (if any) points at. */
	realDir: string;
	isSymlink: boolean;
	tier: Tier;
	fileCount: number;
	/** SKILL.md contents, or null if the skill has no SKILL.md. */
	skillMd: string | null;
}

/** Default skills home; override with SKILL_SYNC_HOME (used by tests). */
export function defaultSkillsHome(): string {
	return process.env.SKILL_SYNC_HOME ?? join(homedir(), ".claude", "skills");
}

export function listLocalSkills(skillsHome: string = defaultSkillsHome()): LocalSkill[] {
	if (!existsSync(skillsHome)) return [];

	const skills: LocalSkill[] = [];
	for (const entry of readdirSync(skillsHome, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue; // .sync-state.json, .upstream/, etc.
		const dir = join(skillsHome, entry.name);

		// A skill entry is a directory or a symlink pointing at one.
		const isSymlink = entry.isSymbolicLink();
		let realDir: string;
		try {
			realDir = realpathSync(dir);
			if (!lstatSync(realDir).isDirectory()) continue;
		} catch {
			continue; // dangling symlink — skip
		}

		const skillMdPath = join(realDir, "SKILL.md");
		if (!existsSync(skillMdPath)) continue; // not a skill

		const tierResult = detectTier(realDir);
		skills.push({
			name: entry.name,
			dir,
			realDir,
			isSymlink,
			tier: tierResult.tier,
			fileCount: tierResult.fileCount,
			skillMd: readFileSync(skillMdPath, "utf8"),
		});
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

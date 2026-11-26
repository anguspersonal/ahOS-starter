import { readdirSync } from "node:fs";
import { join } from "node:path";

// Tier detection (ADR: ahkms as source of truth for single-file skills). The tier
// is COMPUTED from the live file count every run, never curated:
//   - single-file  = exactly one file, SKILL.md          -> ahkms-authoritative
//   - multi-file   = SKILL.md plus supporting files       -> local-authoritative
// Dotfiles (e.g. a stray macOS `.DS_Store`) are ignored so junk never flips a
// single-file skill to multi. This module is PURE apart from reading the given
// directory, so it takes an explicit path and is trivially testable.

export type Tier = "single" | "multi";

export interface TierResult {
	tier: Tier;
	fileCount: number;
	/** Regular-file paths relative to the skill dir, sorted, dotfiles excluded. */
	files: string[];
	hasSkillMd: boolean;
}

function listFiles(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue; // ignore .DS_Store, .git, etc.
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...listFiles(join(dir, entry.name), rel));
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

export function detectTier(skillDir: string): TierResult {
	const files = listFiles(skillDir).sort();
	const hasSkillMd = files.includes("SKILL.md");
	const tier: Tier = files.length === 1 && hasSkillMd ? "single" : "multi";
	return { tier, fileCount: files.length, files, hasSkillMd };
}

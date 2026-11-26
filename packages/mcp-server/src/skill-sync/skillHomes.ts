import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AhkmsCapability } from "./ahkmsSource.js";

// Cached home map for Claude Code skills (~/.claude/cache/skill-homes.json).
// Written during SessionStart auto-reconcile (hook.ts / skill-sync reconcile)
// and read by .claude/hooks/check-skill-home.js to prevent models from forking
// kms-repo-homed skills outside their canonical repo (#811).

export interface CachedSkillHome {
	storage_location: string;
	storage_url: string | null;
}

export interface SkillHomesCacheFile {
	updated_at: string;
	skills: Record<string, CachedSkillHome>;
}

export function defaultSkillHomesCachePath(): string {
	return join(homedir(), ".claude", "cache", "skill-homes.json");
}

export function buildSkillHomesCache(caps: Iterable<AhkmsCapability>): Record<string, CachedSkillHome> {
	const skills: Record<string, CachedSkillHome> = {};
	for (const cap of caps) {
		if (cap.name) {
			skills[cap.name.toLowerCase()] = {
				storage_location: cap.storageLocation,
				storage_url: cap.storageUrl,
			};
		}
	}
	return skills;
}

/**
 * Write the skill homes cache to disk. Fails open on any filesystem error:
 * this cache is an advisory performance optimization for the hook and must
 * never break or stall the session.
 */
export function writeSkillHomesCache(
	caps: Iterable<AhkmsCapability>,
	cachePath: string = defaultSkillHomesCachePath(),
): boolean {
	try {
		const skills = buildSkillHomesCache(caps);
		const payload: SkillHomesCacheFile = {
			updated_at: new Date().toISOString(),
			skills,
		};
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf8");
		return true;
	} catch {
		// fail open, hard
		return false;
	}
}

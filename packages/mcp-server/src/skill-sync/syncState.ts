import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheBase } from "./baseCache.js";

// The per-machine merge-base store (ADR: ahkms as source of truth for single-file
// skills). Lives at <skills-home>/.sync-state.json and is gitignored — the base is
// each machine's own last reconciliation point and must NOT be shared through
// dotclaude. This slice (#370) only READS it; writing is #371's job.

export interface SyncBaseEntry {
	/** Canonical content hash recorded at the last successful sync. */
	hash: string;
	/** ISO timestamp of that sync. */
	syncedAt: string;
}

export interface SyncState {
	version: 1;
	skills: Record<string, SyncBaseEntry>;
}

const EMPTY: SyncState = { version: 1, skills: {} };

export function stateFilePath(skillsHome: string): string {
	return join(skillsHome, ".sync-state.json");
}

/** Read the sync-state file, tolerating absence or corruption (returns empty). */
export function readSyncState(skillsHome: string): SyncState {
	const path = stateFilePath(skillsHome);
	if (!existsSync(path)) return { ...EMPTY, skills: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncState>;
		if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.skills !== "object") {
			return { ...EMPTY, skills: {} };
		}
		return { version: 1, skills: parsed.skills ?? {} };
	} catch {
		// A corrupt state file must not break status/reconcile — treat as "no bases".
		return { ...EMPTY, skills: {} };
	}
}

/** The recorded base hash for a skill, or null if never synced on this machine. */
export function getBaseHash(state: SyncState, skillName: string): string | null {
	return state.skills[skillName]?.hash ?? null;
}

export function writeSyncState(skillsHome: string, state: SyncState): void {
	writeFileSync(stateFilePath(skillsHome), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Record (or update) the merge base for one skill and persist. Read-modify-write.
 *
 * `content`, when given, is stashed in the content-addressed base cache
 * (baseCache.ts, keyed by this same hash) so a LATER conflict on this skill can
 * show a true base->local / base->ahkms diff (`resolve`, #374) instead of just a
 * hash. Optional, but NOT best-effort with respect to ordering: it is written
 * BEFORE the sync-state file is advanced (QA round 1, Medium), so a `cacheBase`
 * failure (disk full, permission error) throws out of `setBase` with the base
 * hash still untouched — consistent with every caller's own contract ("a failed
 * write leaves the base untouched"), instead of leaving the base advanced while
 * the caller reports failure.
 */
export function setBase(skillsHome: string, skillName: string, hash: string, syncedAt: string, content?: string): void {
	if (content !== undefined) cacheBase(skillsHome, hash, content);
	const state = readSyncState(skillsHome);
	state.skills[skillName] = { hash, syncedAt };
	writeSyncState(skillsHome, state);
}

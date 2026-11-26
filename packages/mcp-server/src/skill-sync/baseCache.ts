import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Cache of upstream base content, keyed by git blob hash (#376). The 3-way diff-walk
// needs the exact upstream content a fork was last reconciled against — but a shallow
// upstream clone may have pruned that old blob after a fetch. So we stash the base
// content at map/import time and read it back at walk time. Keyed by blob, so it is
// content-addressed and naturally de-duplicated. Lives under the gitignored .upstream/.

function cacheDir(skillsHome: string): string {
	return join(skillsHome, ".upstream", ".base-cache");
}

// QA round 1 (Medium, #374): before #374 this was written only by the rare
// upstream-fork-walk feature; push/pull/init now write here on every successful
// sync, so an actively-edited skill would otherwise accumulate one small text blob
// per revision forever. Cheap, bounded fix: cap by count rather than tracking which
// blobs are still referenced by some skill's recorded base (that would need
// baseCache.ts to read syncState.ts across every skill, for a file directory that's
// at most a few hundred small text files).
export const MAX_CACHED_BASES = 500;

export function cacheBase(skillsHome: string, blob: string, content: string): void {
	const dir = cacheDir(skillsHome);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, blob), content, "utf8");
	evictOldest(dir);
}

/** Drop the least-recently-written blobs once the cache exceeds MAX_CACHED_BASES.
 *  Content-addressed, so a still-live base is simply re-cached the next time its
 *  skill syncs — eviction can never lose a base that's actually needed right now. */
function evictOldest(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	if (names.length <= MAX_CACHED_BASES) return;

	const withMtime = names
		.map((name) => {
			try {
				return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
			} catch {
				return null;
			}
		})
		.filter((e): e is { name: string; mtimeMs: number } => e !== null)
		.sort((a, b) => a.mtimeMs - b.mtimeMs);

	for (const e of withMtime.slice(0, withMtime.length - MAX_CACHED_BASES)) {
		try {
			unlinkSync(join(dir, e.name));
		} catch {
			// Best-effort: a concurrent cleanup or a file already gone isn't fatal.
		}
	}
}

/** The cached base content for a blob, or null if it was never cached. */
export function readBase(skillsHome: string, blob: string): string | null {
	const p = join(cacheDir(skillsHome), blob);
	return existsSync(p) ? readFileSync(p, "utf8") : null;
}

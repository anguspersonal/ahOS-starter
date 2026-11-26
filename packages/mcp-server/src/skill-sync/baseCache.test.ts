import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CACHED_BASES, cacheBase, readBase } from "./baseCache.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skill-basecache-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/**
 * Writes `count` blobs and force-sets each one's mtime to a distinct,
 * strictly increasing instant (independent of the real filesystem clock's
 * resolution, which is too coarse on some CI filesystems to reliably order
 * hundreds of writes made in a tight loop). Only past timestamps are forced;
 * the write that crosses the eviction threshold still gets its own real "now"
 * mtime at the moment `cacheBase` runs, so it is never mistaken for the
 * oldest entry.
 */
function cacheManyBlobs(home: string, count: number): void {
	const dir = join(home, ".upstream", ".base-cache");
	const start = new Date("2026-01-01T00:00:00Z").getTime();
	for (let i = 0; i < count; i++) {
		cacheBase(home, `blob-${i}`, `content ${i}\n`);
		const t = new Date(start + i * 1000);
		utimesSync(join(dir, `blob-${i}`), t, t);
	}
}

describe("baseCache", () => {
	it("round-trips content by blob key", () => {
		cacheBase(home, "deadbeef", "the base body\n");
		expect(readBase(home, "deadbeef")).toBe("the base body\n");
	});

	it("returns null for an uncached blob", () => {
		expect(readBase(home, "missing")).toBeNull();
	});

	it("caps the cache by count, evicting the oldest blobs first (QA round 1, Medium)", () => {
		cacheManyBlobs(home, MAX_CACHED_BASES + 5);

		const dir = join(home, ".upstream", ".base-cache");
		expect(readdirSync(dir)).toHaveLength(MAX_CACHED_BASES);

		// Oldest evicted, most recent kept.
		expect(existsSync(join(dir, "blob-0"))).toBe(false);
		expect(existsSync(join(dir, "blob-4"))).toBe(false);
		expect(readBase(home, `blob-${MAX_CACHED_BASES + 4}`)).toBe(`content ${MAX_CACHED_BASES + 4}\n`);
	});

	it("still round-trips a live base after eviction has run", () => {
		cacheManyBlobs(home, MAX_CACHED_BASES + 1);
		expect(readBase(home, `blob-${MAX_CACHED_BASES}`)).toBe(`content ${MAX_CACHED_BASES}\n`);
		expect(readBase(home, "blob-0")).toBeNull();
	});
});

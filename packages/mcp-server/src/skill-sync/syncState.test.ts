import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked so one test can force `cacheBase` to throw (QA round 1, Medium:
// `setBase` must cache the content BEFORE advancing the recorded base, so a
// cache-write failure leaves the base untouched — the same invariant every
// other "failed write" path in skill-sync already honours). Defaults to the
// real implementation so every other test here is unaffected.
const cacheBase = vi.hoisted(() => vi.fn());
vi.mock("./baseCache.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./baseCache.js")>();
	cacheBase.mockImplementation(actual.cacheBase);
	return { ...actual, cacheBase: (...args: [string, string, string]) => cacheBase(...args) };
});

const { getBaseHash, readSyncState, setBase, stateFilePath } = await import("./syncState.js");

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skill-state-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("readSyncState", () => {
	it("returns an empty state when the file is absent", () => {
		expect(readSyncState(home)).toEqual({ version: 1, skills: {} });
	});

	it("returns an empty state when the file is corrupt", () => {
		writeFileSync(stateFilePath(home), "{not json");
		expect(readSyncState(home)).toEqual({ version: 1, skills: {} });
	});

	it("reads recorded bases", () => {
		writeFileSync(
			stateFilePath(home),
			JSON.stringify({ version: 1, skills: { "qa-review": { hash: "abc", syncedAt: "2026-07-15T00:00:00Z" } } }),
		);
		const state = readSyncState(home);
		expect(getBaseHash(state, "qa-review")).toBe("abc");
	});
});

describe("getBaseHash", () => {
	it("is null for a skill with no recorded base", () => {
		expect(getBaseHash({ version: 1, skills: {} }, "unknown")).toBeNull();
	});
});

describe("setBase", () => {
	it("persists a base that reads back", () => {
		setBase(home, "qa-review", "deadbeef", "2026-07-15T12:00:00Z");
		expect(getBaseHash(readSyncState(home), "qa-review")).toBe("deadbeef");
	});

	it("updates an existing base in place", () => {
		setBase(home, "qa-review", "one", "2026-07-15T12:00:00Z");
		setBase(home, "qa-review", "two", "2026-07-15T13:00:00Z");
		const state = readSyncState(home);
		expect(getBaseHash(state, "qa-review")).toBe("two");
		expect(Object.keys(state.skills)).toHaveLength(1);
	});

	it("does not advance the recorded base when caching the content fails (QA round 1, Medium)", () => {
		cacheBase.mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		expect(() => setBase(home, "qa-review", "deadbeef", "2026-07-15T12:00:00Z", "the base body\n")).toThrow("disk full");
		expect(getBaseHash(readSyncState(home), "qa-review")).toBeNull();
	});

	it("still advances the base normally once the cache write succeeds again", () => {
		cacheBase.mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		expect(() => setBase(home, "qa-review", "deadbeef", "2026-07-15T12:00:00Z", "the base body\n")).toThrow();

		setBase(home, "qa-review", "deadbeef", "2026-07-15T12:00:01Z", "the base body\n");
		expect(getBaseHash(readSyncState(home), "qa-review")).toBe("deadbeef");
	});
});

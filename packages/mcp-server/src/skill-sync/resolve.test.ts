import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AhkmsCapability } from "./ahkmsSource.js";
import { hashBody } from "./hash.js";
import { getBaseHash, readSyncState, setBase } from "./syncState.js";

// Mirrors `backupPath` in pull.ts (`<home>/.sync-backups/<name>/<stamp>.SKILL.md`).
// Not imported directly: pull.ts is only ever loaded lazily (via the dynamic
// `await import("./resolve.js")` below), after this file's own top-level
// `SkillKindConflictError` class exists for the `ahkmsSource.js` mock factory to
// reference — a static top-level import of pull.ts here would hoist ahead of that
// class declaration and break the mock.
function expectedBackupPath(home: string, name: string, stamp: string): string {
	return join(home, ".sync-backups", name, `${stamp}.SKILL.md`);
}

// Mock the ahkms boundary the same way hook.test.ts / push.test.ts do, so
// findConflicts/resolveConflict can be exercised without network/env.
// `fetchAllCapabilities` drives detection (the SAME function statusForSkill /
// the hook use); `upsertSkillCapability` is the write side `keep-local` calls
// through pushSkill.
const fetchAllCapabilities = vi.fn();
const upsertSkillCapability = vi.fn();
class SkillKindConflictError extends Error {
	constructor(
		readonly capabilityName: string,
		readonly existingKind: string,
	) {
		super(`'${capabilityName}' is already registered as '${existingKind}'`);
		this.name = "SkillKindConflictError";
	}
}
vi.mock("./ahkmsSource.js", () => ({
	fetchAllCapabilities: (...args: unknown[]) => fetchAllCapabilities(...args),
	upsertSkillCapability: (...args: unknown[]) => upsertSkillCapability(...args),
	SkillKindConflictError,
}));

const { findConflicts, formatConflict, resolveConflict } = await import("./resolve.js");

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skill-resolve-"));
	fetchAllCapabilities.mockReset();
	upsertSkillCapability.mockReset();
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function writeSkill(name: string, body: string, opts: { symlink?: boolean } = {}): void {
	const realDir = join(home, opts.symlink ? `.real-${name}` : name);
	mkdirSync(realDir, { recursive: true });
	writeFileSync(join(realDir, "SKILL.md"), body, "utf8");
	if (opts.symlink) symlinkSync(realDir, join(home, name));
}

function writeMultiSkill(name: string, body: string): void {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body, "utf8");
	writeFileSync(join(dir, "extra.md"), "extra\n", "utf8");
}

function cap(name: string, body: string | null): AhkmsCapability {
	return { name, kind: "skill", storageLocation: "kms-db", storageUrl: null, surface: ["claude-code"], body, bodySyncedAt: null };
}

function capsMap(...caps: AhkmsCapability[]): Map<string, AhkmsCapability> {
	return new Map(caps.map((c) => [c.name.toLowerCase(), c]));
}

/** Stamp a base WITH cached content, mirroring what push/pull/init now do (#374). */
function baseWithContent(name: string, content: string): void {
	setBase(home, name, hashBody(content), new Date().toISOString(), content);
}

describe("findConflicts", () => {
	it("enumerates only both-changed (conflict) rows — not local-moved/ahkms-moved/in-sync", async () => {
		writeSkill("qa", "local fork\n");
		baseWithContent("qa", "common base\n");
		writeSkill("local-only-moved", "edited\n");
		baseWithContent("local-only-moved", "edited\n"); // will be overwritten below to diverge base
		setBase(home, "local-only-moved", hashBody("original\n"), new Date().toISOString(), "original\n");
		writeSkill("insync", "same\n");
		baseWithContent("insync", "same\n");
		writeMultiSkill("multi", "---\nx\n---\nbody\n");

		fetchAllCapabilities.mockResolvedValueOnce(
			capsMap(cap("qa", "ahkms fork\n"), cap("local-only-moved", "original\n"), cap("insync", "same\n"), cap("multi", "body\n")),
		);

		const conflicts = await findConflicts(home);

		expect(conflicts.map((c) => c.name)).toEqual(["qa"]);
		expect(conflicts[0].local).toBe("local fork\n");
		expect(conflicts[0].ahkms).toBe("ahkms fork\n");
		expect(conflicts[0].base).toBe("common base\n");
	});

	it("degrades gracefully when the base predates content-caching (hash stamped with no cached content)", async () => {
		writeSkill("legacy", "local fork\n");
		setBase(home, "legacy", hashBody("common base\n"), new Date().toISOString()); // no content arg
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("legacy", "ahkms fork\n")));

		const [c] = await findConflicts(home);

		expect(c.base).toBeNull();
		expect(c.baseHash).toBe(hashBody("common base\n"));
	});

	it("returns an empty list when nothing is in conflict", async () => {
		writeSkill("insync", "same\n");
		baseWithContent("insync", "same\n");
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("insync", "same\n")));

		expect(await findConflicts(home)).toEqual([]);
	});
});

describe("formatConflict", () => {
	it("shows a base->local and base->ahkms unified diff when the base is cached", () => {
		const out = formatConflict({ name: "qa", local: "local line\n", ahkms: "ahkms line\n", baseHash: "x", base: "base line\n" });
		expect(out).toMatch(/base -> local/);
		expect(out).toMatch(/base -> ahkms/);
		expect(out).toMatch(/local line/);
		expect(out).toMatch(/ahkms line/);
	});

	it("falls back to a local-vs-ahkms diff and says why when the base isn't cached", () => {
		const out = formatConflict({ name: "qa", local: "local line\n", ahkms: "ahkms line\n", baseHash: "x", base: null });
		expect(out).toMatch(/base content not cached/);
		expect(out).toMatch(/local line/);
		expect(out).toMatch(/ahkms line/);
	});
});

describe("resolveConflict", () => {
	it("skip: leaves the local file, ahkms, and the base untouched", async () => {
		writeSkill("qa", "local fork\n");
		baseWithContent("qa", "common base\n");
		const before = getBaseHash(readSyncState(home), "qa");
		const c = { name: "qa", local: "local fork\n", ahkms: "ahkms fork\n", baseHash: before as string, base: "common base\n" };

		const res = await resolveConflict(c, "skip", home);

		expect(res.outcome).toBe("skipped");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
		expect(readFileSync(join(home, "qa", "SKILL.md"), "utf8")).toBe("local fork\n");
		expect(getBaseHash(readSyncState(home), "qa")).toBe(before);
	});

	it("keep-local: pushes local to ahkms through pushSkill and advances the base", async () => {
		writeSkill("qa", "local fork\n");
		baseWithContent("qa", "common base\n");
		upsertSkillCapability.mockResolvedValueOnce("updated");
		const c = { name: "qa", local: "local fork\n", ahkms: "ahkms fork\n", baseHash: "x", base: "common base\n" };

		const res = await resolveConflict(c, "keep-local", home);

		expect(res.outcome).toBe("kept-local");
		expect(upsertSkillCapability).toHaveBeenCalledWith(expect.objectContaining({ name: "qa", body: "local fork\n" }));
		expect(getBaseHash(readSyncState(home), "qa")).toBe(hashBody("local fork\n"));
	});

	it("keep-local: a failed push (SkillKindConflictError) reports failed and leaves the base untouched", async () => {
		writeSkill("qa", "local fork\n");
		baseWithContent("qa", "common base\n");
		const before = getBaseHash(readSyncState(home), "qa");
		upsertSkillCapability.mockRejectedValueOnce(new SkillKindConflictError("qa", "agent"));
		const c = { name: "qa", local: "local fork\n", ahkms: "ahkms fork\n", baseHash: before as string, base: "common base\n" };

		const res = await resolveConflict(c, "keep-local", home);

		expect(res.outcome).toBe("failed");
		expect(getBaseHash(readSyncState(home), "qa")).toBe(before);
	});

	it("keep-ahkms: pulls ahkms over local through pullSkill (backed up) and advances the base", async () => {
		writeSkill("qa", "local fork\n");
		baseWithContent("qa", "common base\n");
		const c = { name: "qa", local: "local fork\n", ahkms: "ahkms fork\n", baseHash: "x", base: "common base\n" };

		const res = await resolveConflict(c, "keep-ahkms", home);

		expect(res.outcome).toBe("kept-ahkms");
		expect(readFileSync(join(home, "qa", "SKILL.md"), "utf8")).toBe("ahkms fork\n");
		expect(res.backupPath && existsSync(res.backupPath)).toBe(true);
		expect(getBaseHash(readSyncState(home), "qa")).toBe(hashBody("ahkms fork\n"));
	});

	it("keep-ahkms: never writes through a symlink — reports failed, base untouched", async () => {
		writeSkill("linked", "local fork\n", { symlink: true });
		baseWithContent("linked", "common base\n");
		const before = getBaseHash(readSyncState(home), "linked");
		const c = { name: "linked", local: "local fork\n", ahkms: "ahkms fork\n", baseHash: before as string, base: "common base\n" };

		const res = await resolveConflict(c, "keep-ahkms", home);

		expect(res.outcome).toBe("failed");
		expect(readFileSync(join(home, ".real-linked", "SKILL.md"), "utf8")).toBe("local fork\n");
		expect(getBaseHash(readSyncState(home), "linked")).toBe(before);
	});

	it("merge: writes conflict-marked content to the local SKILL.md, backs the original up, and does NOT advance the base", async () => {
		writeSkill("qa", "line one\nlocal change\n");
		baseWithContent("qa", "line one\nline two\n");
		const before = getBaseHash(readSyncState(home), "qa");
		const c = { name: "qa", local: "line one\nlocal change\n", ahkms: "line one\nahkms change\n", baseHash: before as string, base: "line one\nline two\n" };

		const res = await resolveConflict(c, "merge", home);

		expect(res.outcome).toBe("merge-pending");
		const written = readFileSync(join(home, "qa", "SKILL.md"), "utf8");
		expect(written).toMatch(/<<<<<<</);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
		expect(getBaseHash(readSyncState(home), "qa")).toBe(before);
		expect(res.backupPath && existsSync(res.backupPath)).toBe(true);
		expect(readFileSync(res.backupPath!, "utf8")).toBe("line one\nlocal change\n");
	});

	it("merge: refuses to re-merge a local file that already has unresolved conflict markers (QA round 1, High)", async () => {
		const alreadyMarked = "line one\n<<<<<<< local\nlocal change\n=======\nahkms change\n>>>>>>> upstream\n";
		writeSkill("qa", alreadyMarked);
		baseWithContent("qa", "line one\nline two\n");
		const before = getBaseHash(readSyncState(home), "qa");
		const c = { name: "qa", local: alreadyMarked, ahkms: "line one\nahkms change v2\n", baseHash: before as string, base: "line one\nline two\n" };

		const res = await resolveConflict(c, "merge", home);

		expect(res.outcome).toBe("failed");
		expect(res.reason).toMatch(/already has unresolved conflict markers/);
		// Refused before touching anything: no new backup, file left exactly as-is.
		expect(res.backupPath).toBeUndefined();
		expect(readFileSync(join(home, "qa", "SKILL.md"), "utf8")).toBe(alreadyMarked);
		expect(getBaseHash(readSyncState(home), "qa")).toBe(before);
	});

	it("merge: a second merge (different stamp) never overwrites an earlier merge's backup", async () => {
		writeSkill("qa", "line one\nlocal change\n");
		baseWithContent("qa", "line one\nline two\n");
		const c1 = {
			name: "qa",
			local: "line one\nlocal change\n",
			ahkms: "line one\nahkms change\n",
			baseHash: "x",
			base: "line one\nline two\n",
		};

		const first = await resolveConflict(c1, "merge", home);
		expect(first.outcome).toBe("merge-pending");
		expect(readFileSync(first.backupPath!, "utf8")).toBe("line one\nlocal change\n");

		// Hand-resolve, then a legitimate later conflict on the same skill: the
		// resolved file no longer has markers, so this merge is allowed to proceed,
		// and must not clobber the first backup even if the stamps collide.
		const resolvedLocal = "line one\nresolved by hand\n";
		writeFileSync(join(home, "qa", "SKILL.md"), resolvedLocal, "utf8");
		const c2 = { ...c1, local: resolvedLocal, ahkms: "line one\nahkms change v2\n" };

		const second = await resolveConflict(c2, "merge", home);

		expect(second.outcome).toBe("merge-pending");
		expect(second.backupPath).not.toBe(first.backupPath);
		expect(existsSync(first.backupPath!)).toBe(true);
		expect(readFileSync(first.backupPath!, "utf8")).toBe("line one\nlocal change\n");
		expect(existsSync(second.backupPath!)).toBe(true);
		expect(readFileSync(second.backupPath!, "utf8")).toBe(resolvedLocal);
	});

	it("merge: suffixes the backup instead of overwriting one that already exists at the same stamp", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
		try {
			writeSkill("qa", "line one\nlocal change\n");
			baseWithContent("qa", "line one\nline two\n");
			const collidingPath = expectedBackupPath(home, "qa", "2026-07-15T12-00-00-000Z");
			mkdirSync(dirname(collidingPath), { recursive: true });
			writeFileSync(collidingPath, "pre-existing backup\n", "utf8");
			const c = { name: "qa", local: "line one\nlocal change\n", ahkms: "line one\nahkms change\n", baseHash: "x", base: "line one\nline two\n" };

			const res = await resolveConflict(c, "merge", home);

			expect(res.outcome).toBe("merge-pending");
			expect(res.backupPath).not.toBe(collidingPath);
			expect(readFileSync(collidingPath, "utf8")).toBe("pre-existing backup\n");
			expect(readFileSync(res.backupPath!, "utf8")).toBe("line one\nlocal change\n");
		} finally {
			vi.useRealTimers();
		}
	});

	it("merge: fails cleanly when the base isn't cached (can't hand-merge without it)", async () => {
		writeSkill("legacy", "local fork\n");
		setBase(home, "legacy", hashBody("common base\n"), new Date().toISOString());
		const before = getBaseHash(readSyncState(home), "legacy");
		const c = { name: "legacy", local: "local fork\n", ahkms: "ahkms fork\n", baseHash: before as string, base: null };

		const res = await resolveConflict(c, "merge", home);

		expect(res.outcome).toBe("failed");
		expect(res.reason).toMatch(/no cached base/);
	});

	it("reports failed for a skill that no longer exists locally", async () => {
		const c = { name: "gone", local: "x\n", ahkms: "y\n", baseHash: "x", base: "b\n" };

		const res = await resolveConflict(c, "keep-local", home);

		expect(res.outcome).toBe("failed");
		expect(res.reason).toMatch(/no such local skill/);
	});
});

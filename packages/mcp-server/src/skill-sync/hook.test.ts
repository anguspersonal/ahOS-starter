import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AhkmsCapability } from "./ahkmsSource.js";
import { hashBody } from "./hash.js";
import { getBaseHash, readSyncState, setBase } from "./syncState.js";

// Mock the ahkms boundary so the SessionStart reconcile can be exercised without
// network/env. `fetchAllCapabilities` is the read side (drives classification) and
// `upsertSkillCapability` is the write side pushSkill calls. pullSkill is pure and
// hits the real filesystem under a temp skills home.
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

const { reconcileAll, formatReconcile } = await import("./hook.js");
const { resolveMultiFileBody } = await import("./push.js");

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skill-hook-"));
	fetchAllCapabilities.mockReset();
	upsertSkillCapability.mockReset();
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Write a real single-file skill under home (optionally via a symlink into a sibling). */
function writeSkill(name: string, body: string, opts: { symlink?: boolean } = {}): void {
	const realDir = join(home, opts.symlink ? `.real-${name}` : name);
	mkdirSync(realDir, { recursive: true });
	writeFileSync(join(realDir, "SKILL.md"), body, "utf8");
	if (opts.symlink) symlinkSync(realDir, join(home, name));
}

/** Write a real multi-file skill (SKILL.md + a supporting file) under home. */
function writeMultiSkill(name: string, body: string): void {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body, "utf8");
	writeFileSync(join(dir, "extra.md"), "extra\n", "utf8");
}

/** Write a real multi-file skill WITH a skill-sync.json manifest declaring `extra.md`. */
function writeManifestSkill(name: string, skillMdBody: string, extraBody: string): void {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), skillMdBody, "utf8");
	writeFileSync(join(dir, "extra.md"), extraBody, "utf8");
	writeFileSync(join(dir, "skill-sync.json"), JSON.stringify({ supporting_files: [{ path: "extra.md", travels: true }] }), "utf8");
}

/** A skill-kind kms-db capability with the given body. */
function cap(name: string, body: string | null): AhkmsCapability {
	return { name, kind: "skill", storageLocation: "kms-db", storageUrl: null, surface: ["claude-code"], body, bodySyncedAt: null };
}

function capsMap(...caps: AhkmsCapability[]): Map<string, AhkmsCapability> {
	return new Map(caps.map((c) => [c.name.toLowerCase(), c]));
}

describe("reconcileAll", () => {
	it("auto-pushes an unpushed local edit (local moved, ahkms didn't)", async () => {
		// base == ahkms (last synced), local has since been edited → local-moved.
		writeSkill("qa", "EDITED locally\n");
		setBase(home, "qa", hashBody("old body\n"), new Date().toISOString());
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("qa", "old body\n")));
		upsertSkillCapability.mockResolvedValueOnce("updated");

		const res = await reconcileAll(home);

		expect(res.reachedAhkms).toBe(true);
		expect(upsertSkillCapability).toHaveBeenCalledWith(expect.objectContaining({ name: "qa", body: "EDITED locally\n" }));
		expect(res.events).toContainEqual(expect.objectContaining({ name: "qa", outcome: "pushed" }));
		// base advanced to the pushed content
		expect(getBaseHash(readSyncState(home), "qa")).toBe(hashBody("EDITED locally\n"));
	});

	it("auto-pulls an ahkms edit over an unchanged local file, backing it up (bug fixed)", async () => {
		// base == local (untouched here), ahkms moved on another surface → ahkms-moved.
		writeSkill("qa", "old body\n");
		setBase(home, "qa", hashBody("old body\n"), new Date().toISOString());
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("qa", "NEW from another surface\n")));

		const res = await reconcileAll(home);

		const ev = res.events.find((e) => e.name === "qa");
		expect(ev?.outcome).toBe("pulled");
		// local file was refreshed from ahkms
		expect(readFileSync(join(home, "qa", "SKILL.md"), "utf8")).toBe("NEW from another surface\n");
		// and the pre-overwrite copy is recoverable
		expect(ev?.backupPath && existsSync(ev.backupPath)).toBe(true);
		expect(readFileSync(ev!.backupPath!, "utf8")).toBe("old body\n");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("never auto-applies a both-changed conflict — logs it and counts it", async () => {
		// base differs from BOTH local and ahkms, and they differ from each other.
		writeSkill("qa", "local fork\n");
		setBase(home, "qa", hashBody("common base\n"), new Date().toISOString());
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("qa", "ahkms fork\n")));

		const res = await reconcileAll(home);

		expect(res.conflicts).toBe(1);
		expect(res.events).toContainEqual(expect.objectContaining({ name: "qa", outcome: "conflict" }));
		// neither side was written, no push
		expect(readFileSync(join(home, "qa", "SKILL.md"), "utf8")).toBe("local fork\n");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
		expect(getBaseHash(readSyncState(home), "qa")).toBe(hashBody("common base\n"));
	});

	it("advances the base for a converged skill (both moved to the same content) without writing", async () => {
		writeSkill("qa", "same new content\n");
		setBase(home, "qa", hashBody("old\n"), new Date().toISOString());
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("qa", "same new content\n")));

		const res = await reconcileAll(home);

		expect(res.events).toContainEqual(expect.objectContaining({ name: "qa", outcome: "converged" }));
		expect(upsertSkillCapability).not.toHaveBeenCalled();
		expect(getBaseHash(readSyncState(home), "qa")).toBe(hashBody("same new content\n"));
	});

	it("fails open when ahkms is unreachable — no throw, boot proceeds", async () => {
		writeSkill("qa", "local\n");
		fetchAllCapabilities.mockRejectedValueOnce(new Error("ECONNREFUSED"));

		const res = await reconcileAll(home);

		expect(res.reachedAhkms).toBe(false);
		expect(res.warning).toMatch(/unreachable/);
		expect(res.events).toEqual([]);
		expect(res.conflicts).toBe(0);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("keeps reconciling other skills when one skill's push errors (per-skill fail-open)", async () => {
		writeSkill("boom", "edited\n");
		setBase(home, "boom", hashBody("base\n"), new Date().toISOString());
		writeSkill("fine", "edited\n");
		setBase(home, "fine", hashBody("base\n"), new Date().toISOString());
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("boom", "base\n"), cap("fine", "base\n")));
		// boom's push throws; fine's succeeds. Order of listLocalSkills is alphabetical.
		upsertSkillCapability.mockImplementation((input: { name: string }) => {
			if (input.name === "boom") return Promise.reject(new Error("network down"));
			return Promise.resolve("updated");
		});

		const res = await reconcileAll(home);

		expect(res.reachedAhkms).toBe(true);
		expect(res.events).toContainEqual(expect.objectContaining({ name: "boom", outcome: "warned", reason: "network down" }));
		expect(res.events).toContainEqual(expect.objectContaining({ name: "fine", outcome: "pushed" }));
	});

	it("leaves symlinked skills compare-only — warns, never writes through the link", async () => {
		writeSkill("linked", "local\n", { symlink: true });
		setBase(home, "linked", hashBody("local\n"), new Date().toISOString());
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("linked", "different on ahkms\n")));

		const res = await reconcileAll(home);

		const ev = res.events.find((e) => e.name === "linked");
		expect(ev?.outcome).toBe("warned");
		// the real file behind the symlink is untouched
		expect(readFileSync(join(home, ".real-linked", "SKILL.md"), "utf8")).toBe("local\n");
	});

	it("skips in-sync and multi-file skills silently", async () => {
		writeSkill("insync", "same\n");
		setBase(home, "insync", hashBody("same\n"), new Date().toISOString());
		writeMultiSkill("multi", "---\nx\n---\nbody\n");
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("insync", "same\n"), cap("multi", "body\n")));

		const res = await reconcileAll(home);

		// No push/pull events for either; multi-file is never even classified for reconcile.
		expect(res.events.filter((e) => e.outcome !== "skipped")).toEqual([]);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	// Round 1 QA High finding: manifest-declared multi-file skills ARE pushed to
	// kms-db by push.ts, so the reconcile hook must classify and act on them like
	// single-file skills — push local edits, but never blindly overwrite SKILL.md
	// on the pull side (see pull.test.ts for why).
	it("auto-pushes a manifest-declared multi-file skill's local edit (local moved)", async () => {
		writeManifestSkill("bundle", "---\nname: bundle\n---\nOLD\n", "extra\n");
		const oldSkill = { name: "bundle", dir: join(home, "bundle"), realDir: join(home, "bundle"), isSymlink: false, tier: "multi" as const, fileCount: 3, skillMd: "---\nname: bundle\n---\nOLD\n" };
		const oldAssembled = resolveMultiFileBody(oldSkill);
		if (!oldAssembled.ok) throw new Error(`expected assembly to succeed: ${oldAssembled.reason}`);
		setBase(home, "bundle", hashBody(oldAssembled.body), new Date().toISOString());
		// Edit SKILL.md locally after the base was recorded.
		writeFileSync(join(home, "bundle", "SKILL.md"), "---\nname: bundle\n---\nEDITED\n", "utf8");
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("bundle", oldAssembled.body)));
		upsertSkillCapability.mockResolvedValueOnce("updated");

		const res = await reconcileAll(home);

		expect(res.events).toContainEqual(expect.objectContaining({ name: "bundle", outcome: "pushed" }));
		expect(upsertSkillCapability).toHaveBeenCalledWith(expect.objectContaining({ name: "bundle", body: expect.stringContaining("EDITED") }));
	});

	it("warns instead of overwriting when a manifest-declared multi-file skill's ahkms body has moved", async () => {
		writeManifestSkill("bundle", "---\nname: bundle\n---\nmain\n", "extra\n");
		const skill = { name: "bundle", dir: join(home, "bundle"), realDir: join(home, "bundle"), isSymlink: false, tier: "multi" as const, fileCount: 3, skillMd: "---\nname: bundle\n---\nmain\n" };
		const assembled = resolveMultiFileBody(skill);
		if (!assembled.ok) throw new Error(`expected assembly to succeed: ${assembled.reason}`);
		setBase(home, "bundle", hashBody(assembled.body), new Date().toISOString());
		fetchAllCapabilities.mockResolvedValueOnce(capsMap(cap("bundle", "a different assembled body from another surface\n")));

		const res = await reconcileAll(home);

		const ev = res.events.find((e) => e.name === "bundle");
		expect(ev?.outcome).toBe("warned");
		// SKILL.md is untouched — never corrupted by writing an assembled body verbatim.
		expect(readFileSync(join(home, "bundle", "SKILL.md"), "utf8")).toBe("---\nname: bundle\n---\nmain\n");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});
});

describe("formatReconcile", () => {
	it("summarises pushed/pulled and surfaces a conflict count with the resolve hint", () => {
		const out = formatReconcile({
			reachedAhkms: true,
			events: [
				{ name: "a", outcome: "pushed" },
				{ name: "b", outcome: "pulled", backupPath: "/x" },
			],
			conflicts: 2,
		});
		expect(out).toMatch(/pushed 1 local→ahkms: a/);
		expect(out).toMatch(/pulled 1 ahkms→local \(backed up\): b/);
		expect(out).toMatch(/2 conflicts — run `\/skill-sync resolve`/);
	});

	it("uses singular 'conflict' for exactly one", () => {
		const out = formatReconcile({ reachedAhkms: true, events: [], conflicts: 1 });
		expect(out).toMatch(/1 conflict — run/);
	});

	it("reports the fail-open warning when ahkms was unreachable", () => {
		const out = formatReconcile({ reachedAhkms: false, warning: "ahkms unreachable — x", events: [], conflicts: 0 });
		expect(out).toMatch(/ahkms unreachable/);
		expect(out).toMatch(/continuing/);
	});

	it("says skills in sync when nothing happened", () => {
		expect(formatReconcile({ reachedAhkms: true, events: [], conflicts: 0 })).toBe("skill-sync: skills in sync.");
	});
});

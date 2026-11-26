import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBody } from "./hash.js";
import type { LocalSkill } from "./localSkills.js";
import { pullSkill } from "./pull.js";
import { resolveMultiFileBody } from "./push.js";
import { getBaseHash, readSyncState } from "./syncState.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skill-pull-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Create a real single-file skill under home (optionally via a symlink) and describe it. */
function makeSkill(name: string, body: string, opts: { symlink?: boolean } = {}): LocalSkill {
	const realDir = join(home, opts.symlink ? `.real-${name}` : name);
	mkdirSync(realDir, { recursive: true });
	writeFileSync(join(realDir, "SKILL.md"), body, "utf8");
	let dir = realDir;
	let isSymlink = false;
	if (opts.symlink) {
		dir = join(home, name);
		symlinkSync(realDir, dir);
		isSymlink = true;
	}
	return { name, dir, realDir, isSymlink, tier: "single", fileCount: 1, skillMd: body };
}

/** Create a real multi-file skill with a skill-sync.json manifest declaring `extra.md`. */
function makeManifestSkill(name: string, skillMdBody: string, extraBody: string): LocalSkill {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), skillMdBody, "utf8");
	writeFileSync(join(dir, "extra.md"), extraBody, "utf8");
	writeFileSync(join(dir, "skill-sync.json"), JSON.stringify({ supporting_files: [{ path: "extra.md", travels: true }] }), "utf8");
	return { name, dir, realDir: dir, isSymlink: false, tier: "multi", fileCount: 3, skillMd: skillMdBody };
}

describe("pullSkill", () => {
	it("skips a multi-file skill (local-authoritative)", () => {
		const skill = { ...makeSkill("m", "x\n"), tier: "multi" as const, fileCount: 2 };
		expect(pullSkill(skill, home, "y\n").outcome).toBe("skipped");
	});

	// Round 1 QA High finding: a manifest-declared multi-file skill IS pushed to
	// kms-db by push.ts, so pullSkill must be able to detect drift on it too —
	// but must never write the assembled ahkms body back into SKILL.md (that
	// would corrupt the file), so a real divergence is flagged, not applied.
	it("stamps the base and skips (no write) when the manifest-declared skill is already in sync", () => {
		const skill = makeManifestSkill("bundle-eq", "---\nname: bundle-eq\n---\nmain\n", "extra\n");
		const resolved = resolveMultiFileBody(skill);
		if (!resolved.ok) throw new Error(`expected assembly to succeed: ${resolved.reason}`);

		const res = pullSkill(skill, home, resolved.body);

		expect(res.outcome).toBe("skipped");
		expect(getBaseHash(readSyncState(home), "bundle-eq")).toBe(hashBody(resolved.body));
		// SKILL.md is untouched — no overwrite for an already-equal multi-file body.
		expect(readFileSync(join(skill.realDir, "SKILL.md"), "utf8")).toBe("---\nname: bundle-eq\n---\nmain\n");
	});

	it("warns (never overwrites SKILL.md) when a manifest-declared skill's ahkms body has drifted", () => {
		const skill = makeManifestSkill("bundle-drift", "---\nname: bundle-drift\n---\nmain\n", "extra\n");

		const res = pullSkill(skill, home, "a completely different assembled body\n");

		expect(res.outcome).toBe("warned");
		expect(res.reason).toMatch(/not auto-pulled/);
		// SKILL.md and the supporting file are untouched — never corrupted by a
		// blind overwrite with the assembled ahkms body.
		expect(readFileSync(join(skill.realDir, "SKILL.md"), "utf8")).toBe("---\nname: bundle-drift\n---\nmain\n");
		expect(readFileSync(join(skill.realDir, "extra.md"), "utf8")).toBe("extra\n");
	});

	it("skips when ahkms has no body", () => {
		expect(pullSkill(makeSkill("a", "local\n"), home, null).outcome).toBe("skipped");
	});

	it("backs up then overwrites local from ahkms, and advances the base", () => {
		const skill = makeSkill("qa", "OLD local body\n");
		const res = pullSkill(skill, home, "NEW ahkms body\n");
		expect(res.outcome).toBe("pulled");
		expect(readFileSync(join(skill.realDir, "SKILL.md"), "utf8")).toBe("NEW ahkms body\n");
		// backup captured the pre-overwrite content and is recoverable
		expect(res.backupPath && existsSync(res.backupPath)).toBe(true);
		expect(readFileSync(res.backupPath!, "utf8")).toBe("OLD local body\n");
		expect(getBaseHash(readSyncState(home), "qa")).toBe(hashBody("NEW ahkms body\n"));
	});

	it("stamps the base and skips when local already equals ahkms", () => {
		const res = pullSkill(makeSkill("eq", "same\n"), home, "same\n");
		expect(res.outcome).toBe("skipped");
		expect(getBaseHash(readSyncState(home), "eq")).toBe(hashBody("same\n"));
	});

	it("never writes through a symlink; warns when ahkms differs", () => {
		const skill = makeSkill("linked", "local\n", { symlink: true });
		const res = pullSkill(skill, home, "different\n");
		expect(res.outcome).toBe("warned");
		expect(readFileSync(join(skill.realDir, "SKILL.md"), "utf8")).toBe("local\n");
	});

	it("skips a symlinked skill that already matches ahkms", () => {
		const skill = makeSkill("linked2", "same\n", { symlink: true });
		expect(pullSkill(skill, home, "same\n").outcome).toBe("skipped");
	});
});

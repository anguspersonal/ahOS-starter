import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLocalSkills } from "./localSkills.js";

// Exercises the fs seam of listLocalSkills over a real tmpdir tree (single-file /
// multi-file / symlinked / dotfile-ignored / missing-SKILL.md). Pattern follows
// syncState.test.ts (mkdtempSync + rmSync).

let home: string;
beforeEach(() => {
	// realpathSync is load-bearing, not cosmetic (#459): on macOS `tmpdir()` is
	// `/var/folders/…`, itself a symlink to `/private/var/folders/…`. listLocalSkills
	// resolves `realDir` with realpathSync, so without canonicalising the root here the
	// `dir === realDir` assertion for a non-symlinked skill compares two spellings of
	// the same path and fails. Linux CI never saw it — `/tmp` isn't symlinked there.
	home = realpathSync(mkdtempSync(join(tmpdir(), "skill-local-")));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Write a single-file skill directory (just a SKILL.md) under home. */
function writeSingle(name: string, body = "single body\n"): string {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body, "utf8");
	return dir;
}

describe("listLocalSkills", () => {
	it("returns an empty array when the skills home does not exist", () => {
		expect(listLocalSkills(join(home, "does-not-exist"))).toEqual([]);
	});

	it("returns an empty array for an empty skills home", () => {
		expect(listLocalSkills(home)).toEqual([]);
	});

	it("reads a single-file skill, tiered single with its SKILL.md body", () => {
		writeSingle("alpha", "hello\n");
		const skills = listLocalSkills(home);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "alpha",
			tier: "single",
			isSymlink: false,
			fileCount: 1,
			skillMd: "hello\n",
		});
		expect(skills[0].dir).toBe(skills[0].realDir);
	});

	it("tiers a directory with supporting files as multi-file", () => {
		const dir = join(home, "beta");
		mkdirSync(join(dir, "scripts"), { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "b\n", "utf8");
		writeFileSync(join(dir, "reference.md"), "ref\n", "utf8");
		writeFileSync(join(dir, "scripts", "run.sh"), "echo\n", "utf8");
		const skills = listLocalSkills(home);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ name: "beta", tier: "multi", fileCount: 3 });
	});

	it("resolves a symlinked skill, flags it isSymlink, and keeps dir vs realDir distinct", () => {
		const realDir = join(home, ".real-linked");
		mkdirSync(realDir, { recursive: true });
		writeFileSync(join(realDir, "SKILL.md"), "linked\n", "utf8");
		const linkDir = join(home, "linked");
		symlinkSync(realDir, linkDir);

		const skills = listLocalSkills(home);
		// The `.real-linked` source is dotfile-ignored; only the `linked` symlink surfaces.
		expect(skills).toHaveLength(1);
		const s = skills[0];
		expect(s.name).toBe("linked");
		expect(s.isSymlink).toBe(true);
		expect(s.skillMd).toBe("linked\n");
		expect(s.dir).not.toBe(s.realDir);
	});

	it("ignores dotfile / dot-dir entries (.sync-state.json, .upstream)", () => {
		writeSingle("gamma");
		writeFileSync(join(home, ".sync-state.json"), "{}", "utf8");
		mkdirSync(join(home, ".upstream"), { recursive: true });
		writeFileSync(join(home, ".upstream", "SKILL.md"), "nope\n", "utf8");

		const skills = listLocalSkills(home);
		expect(skills.map((s) => s.name)).toEqual(["gamma"]);
	});

	it("skips a directory that has no SKILL.md", () => {
		mkdirSync(join(home, "not-a-skill"), { recursive: true });
		writeFileSync(join(home, "not-a-skill", "README.md"), "x\n", "utf8");
		writeSingle("real");

		const skills = listLocalSkills(home);
		expect(skills.map((s) => s.name)).toEqual(["real"]);
	});

	it("skips a dangling symlink without throwing", () => {
		symlinkSync(join(home, "missing-target"), join(home, "dangling"));
		writeSingle("kept");

		const skills = listLocalSkills(home);
		expect(skills.map((s) => s.name)).toEqual(["kept"]);
	});

	it("skips a plain file sitting directly in the skills home", () => {
		writeFileSync(join(home, "loose.txt"), "x\n", "utf8");
		writeSingle("delta");

		const skills = listLocalSkills(home);
		expect(skills.map((s) => s.name)).toEqual(["delta"]);
	});

	it("returns skills sorted by name", () => {
		writeSingle("zeta");
		writeSingle("alpha");
		writeSingle("mu");

		expect(listLocalSkills(home).map((s) => s.name)).toEqual(["alpha", "mu", "zeta"]);
	});
});

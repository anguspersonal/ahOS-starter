import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashBody } from "./hash.js";
import type { LocalSkill } from "./localSkills.js";
import { getBaseHash, readSyncState } from "./syncState.js";

// Mock the ahkms write path (mirrors init.test.ts's pattern for the read path) so
// push.ts's orchestration can be exercised without network/env. `SkillKindConflictError`
// is defined here rather than imported from the real module, but it's still the SAME
// class push.ts's `instanceof` check sees at runtime, because push.ts imports it from
// this same mocked "./ahkmsSource.js" module.
const upsertSkillCapability = vi.fn();
class SkillKindConflictError extends Error {
	constructor(
		readonly capabilityName: string,
		readonly existingKind: string,
	) {
		super(`'${capabilityName}' is already registered as '${existingKind}', not a skill — refusing to overwrite`);
		this.name = "SkillKindConflictError";
	}
}
vi.mock("./ahkmsSource.js", () => ({
	upsertSkillCapability: (...args: unknown[]) => upsertSkillCapability(...args),
	SkillKindConflictError,
}));

const { pushSkill, pushAllSingleFile, pushByName, CROSS_SURFACE } = await import("./push.js");

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skill-push-"));
	upsertSkillCapability.mockReset();
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Create a real single-file skill (SKILL.md only) under home and describe it. */
function makeLocalSkill(name: string, body: string): LocalSkill {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body, "utf8");
	return { name, dir, realDir: dir, isSymlink: false, tier: "single", fileCount: 1, skillMd: body };
}

/** Create a real multi-file skill (SKILL.md + a supporting file) under home. */
function makeMultiSkill(name: string): LocalSkill {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	const body = "---\nname: x\n---\nbody\n";
	writeFileSync(join(dir, "SKILL.md"), body, "utf8");
	writeFileSync(join(dir, "extra.md"), "extra\n", "utf8");
	return { name, dir, realDir: dir, isSymlink: false, tier: "multi", fileCount: 2, skillMd: body };
}

describe("pushSkill", () => {
	it("skips setBase when upsertSkillCapability throws SkillKindConflictError (base is not stamped)", async () => {
		upsertSkillCapability.mockRejectedValueOnce(new SkillKindConflictError("qa", "agent"));
		const skill = makeLocalSkill("qa", "body\n");

		const res = await pushSkill(skill, home);

		expect(res.outcome).toBe("skipped");
		expect(res.reason).toMatch(/already registered as agent/);
		expect(getBaseHash(readSyncState(home), "qa")).toBeNull();
	});

	it("stamps the base with the local body hash on a successful (created) push", async () => {
		upsertSkillCapability.mockResolvedValueOnce("created");
		const skill = makeLocalSkill("new-skill", "hello world\n");

		const res = await pushSkill(skill, home);

		expect(res.outcome).toBe("created");
		expect(getBaseHash(readSyncState(home), "new-skill")).toBe(hashBody("hello world\n"));
	});

	it("stamps the base on a successful (updated) push too", async () => {
		upsertSkillCapability.mockResolvedValueOnce("updated");
		const skill = makeLocalSkill("existing-skill", "updated body\n");

		const res = await pushSkill(skill, home);

		expect(res.outcome).toBe("updated");
		expect(getBaseHash(readSyncState(home), "existing-skill")).toBe(hashBody("updated body\n"));
	});

	it("skips a multi-file skill without calling upsertSkillCapability when no supporting_files declared", async () => {
		const skill = makeMultiSkill("multi");

		const res = await pushSkill(skill, home);

		expect(res.outcome).toBe("skipped");
		expect(res.reason).toMatch(/multi-file/);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("assembles and pushes a multi-file skill with supporting files declared in skill-sync.json", async () => {
		upsertSkillCapability.mockResolvedValueOnce("created");
		const dir = join(home, "multi-json");
		mkdirSync(join(dir, "references"), { recursive: true });
		const body = "---\nname: multi-json\ndescription: multi skill\n---\n# Main\nSee reference.\n";
		writeFileSync(join(dir, "SKILL.md"), body, "utf8");
		writeFileSync(join(dir, "references", "guide.md"), "# Guide\nFollow this.\n", "utf8");
		writeFileSync(
			join(dir, "skill-sync.json"),
			JSON.stringify({
				supporting_files: [{ path: "references/guide.md", travels: true }],
			}),
			"utf8",
		);

		const skill: LocalSkill = {
			name: "multi-json",
			dir,
			realDir: dir,
			isSymlink: false,
			tier: "multi",
			fileCount: 3,
			skillMd: body,
		};

		const res = await pushSkill(skill, home);

		expect(res.outcome).toBe("created");
		expect(upsertSkillCapability).toHaveBeenCalledTimes(1);
		const callArg = upsertSkillCapability.mock.calls[0][0];
		expect(callArg.name).toBe("multi-json");
		expect(callArg.description).toBe("multi skill");
		expect(callArg.body).toContain("# Bundled supporting files");
		expect(callArg.body).toContain("## `references/guide.md`");
		expect(callArg.body).toContain("# Guide\nFollow this.");
		expect(getBaseHash(readSyncState(home), "multi-json")).toBe(hashBody(callArg.body));
	});

	it("assembles and pushes a multi-file skill with supporting files declared in frontmatter", async () => {
		upsertSkillCapability.mockResolvedValueOnce("created");
		const dir = join(home, "multi-fm");
		mkdirSync(join(dir, "rubrics"), { recursive: true });
		const body = [
			"---",
			"name: multi-fm",
			"description: frontmatter declared",
			"supporting_files:",
			"  - path: rubrics/eval.md",
			"    travels: true",
			"---",
			"# Body",
			"Refer to rubrics.",
		].join("\n");
		writeFileSync(join(dir, "SKILL.md"), body, "utf8");
		writeFileSync(join(dir, "rubrics", "eval.md"), "Evaluation criteria.\n", "utf8");

		const skill: LocalSkill = {
			name: "multi-fm",
			dir,
			realDir: dir,
			isSymlink: false,
			tier: "multi",
			fileCount: 2,
			skillMd: body,
		};

		const res = await pushSkill(skill, home);

		expect(res.outcome).toBe("created");
		expect(upsertSkillCapability).toHaveBeenCalledTimes(1);
		const callArg = upsertSkillCapability.mock.calls[0][0];
		expect(callArg.body).toContain("# Bundled supporting files");
		expect(callArg.body).toContain("Evaluation criteria.");
	});

	it("honors surface declaration from skill-sync.json", async () => {
		upsertSkillCapability.mockResolvedValueOnce("created");
		const dir = join(home, "surface-skill");
		mkdirSync(dir, { recursive: true });
		const body = "---\nname: surface-skill\n---\n# Main\n";
		writeFileSync(join(dir, "SKILL.md"), body, "utf8");
		writeFileSync(join(dir, "extra.md"), "extra content\n", "utf8");
		writeFileSync(
			join(dir, "skill-sync.json"),
			JSON.stringify({
				surface: ["claude-code"],
				supporting_files: [{ path: "extra.md", travels: true }],
			}),
			"utf8",
		);

		const skill: LocalSkill = {
			name: "surface-skill",
			dir,
			realDir: dir,
			isSymlink: false,
			tier: "multi",
			fileCount: 3,
			skillMd: body,
		};

		const res = await pushSkill(skill, home);
		expect(res.outcome).toBe("created");
		expect(upsertSkillCapability).toHaveBeenCalledWith(
			expect.objectContaining({ surface: ["claude-code"] }),
		);
	});

	it("skips when declared travelling file does not exist on disk", async () => {
		const dir = join(home, "missing-file");
		mkdirSync(dir, { recursive: true });
		const body = "---\nname: missing-file\n---\n# Main\n";
		writeFileSync(join(dir, "SKILL.md"), body, "utf8");
		writeFileSync(
			join(dir, "skill-sync.json"),
			JSON.stringify({
				supporting_files: [{ path: "ghost.md", travels: true }],
			}),
			"utf8",
		);

		const skill: LocalSkill = {
			name: "missing-file",
			dir,
			realDir: dir,
			isSymlink: false,
			tier: "multi",
			fileCount: 2,
			skillMd: body,
		};

		const res = await pushSkill(skill, home);
		expect(res.outcome).toBe("skipped");
		expect(res.reason).toContain("declared travelling file 'ghost.md' does not exist on disk");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("skips when travelling file contains NUL byte (uncarriable)", async () => {
		const dir = join(home, "binary-file");
		mkdirSync(dir, { recursive: true });
		const body = "---\nname: binary-file\n---\n# Main\n";
		writeFileSync(join(dir, "SKILL.md"), body, "utf8");
		writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2]));
		writeFileSync(
			join(dir, "skill-sync.json"),
			JSON.stringify({
				supporting_files: [{ path: "bin.dat", travels: true }],
			}),
			"utf8",
		);

		const skill: LocalSkill = {
			name: "binary-file",
			dir,
			realDir: dir,
			isSymlink: false,
			tier: "multi",
			fileCount: 3,
			skillMd: body,
		};

		const res = await pushSkill(skill, home);
		expect(res.outcome).toBe("skipped");
		expect(res.reason).toContain("contains a NUL byte");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("skips (does not throw) when a supporting_files entry is missing 'path' — round 1 QA regression", async () => {
		const dir = join(home, "malformed-decl");
		mkdirSync(dir, { recursive: true });
		const body = "---\nname: malformed-decl\n---\n# Main\n";
		writeFileSync(join(dir, "SKILL.md"), body, "utf8");
		writeFileSync(
			join(dir, "skill-sync.json"),
			JSON.stringify({
				supporting_files: [{ travels: true }],
			}),
			"utf8",
		);

		const skill: LocalSkill = {
			name: "malformed-decl",
			dir,
			realDir: dir,
			isSymlink: false,
			tier: "multi",
			fileCount: 2,
			skillMd: body,
		};

		const res = await pushSkill(skill, home);
		expect(res.outcome).toBe("skipped");
		expect(res.reason).toMatch(/missing a valid 'path'/);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("does not let one malformed manifest abort the rest of a pushAll batch", async () => {
		upsertSkillCapability.mockResolvedValue("created");
		makeLocalSkill("single-ok", "ok\n");
		const dir = join(home, "malformed-in-batch");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\nname: malformed-in-batch\n---\nbody\n", "utf8");
		writeFileSync(join(dir, "skill-sync.json"), JSON.stringify({ supporting_files: [{ travels: true }] }), "utf8");

		const results = await pushAllSingleFile(home);

		const okResult = results.find((r) => r.name === "single-ok");
		const badResult = results.find((r) => r.name === "malformed-in-batch");
		expect(okResult?.outcome).toBe("created");
		expect(badResult?.outcome).toBe("skipped");
		expect(upsertSkillCapability).toHaveBeenCalledTimes(1);
	});

	it("refuses a declared travelling path that escapes the skill's own directory (path traversal)", async () => {
		const dir = join(home, "traversal");
		mkdirSync(dir, { recursive: true });
		const body = "---\nname: traversal\n---\n# Main\n";
		writeFileSync(join(dir, "SKILL.md"), body, "utf8");
		// A real file that exists OUTSIDE the skill directory, so this would
		// succeed (and leak the file into the pushed body) without the check.
		writeFileSync(join(home, "outside-secret.txt"), "top secret\n", "utf8");
		writeFileSync(
			join(dir, "skill-sync.json"),
			JSON.stringify({
				supporting_files: [{ path: "../outside-secret.txt", travels: true }],
			}),
			"utf8",
		);

		const skill: LocalSkill = {
			name: "traversal",
			dir,
			realDir: dir,
			isSymlink: false,
			tier: "multi",
			fileCount: 2,
			skillMd: body,
		};

		const res = await pushSkill(skill, home);
		expect(res.outcome).toBe("skipped");
		expect(res.reason).toContain("escapes the skill's own directory");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("skips a skill with no SKILL.md without calling upsertSkillCapability", async () => {
		const skill: LocalSkill = {
			name: "empty",
			dir: home,
			realDir: home,
			isSymlink: false,
			tier: "single",
			fileCount: 0,
			skillMd: null,
		};

		const res = await pushSkill(skill, home);

		expect(res.outcome).toBe("skipped");
		expect(res.reason).toMatch(/no SKILL\.md/);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("propagates a non-conflict error from upsertSkillCapability and does not stamp the base", async () => {
		upsertSkillCapability.mockRejectedValueOnce(new Error("network down"));
		const skill = makeLocalSkill("boom", "body\n");

		await expect(pushSkill(skill, home)).rejects.toThrow("network down");
		expect(getBaseHash(readSyncState(home), "boom")).toBeNull();
	});

	it("passes the parsed description and the default CROSS_SURFACE through to upsertSkillCapability", async () => {
		upsertSkillCapability.mockResolvedValueOnce("created");
		const skill = makeLocalSkill("described", "---\ndescription: does a thing\n---\nbody\n");

		await pushSkill(skill, home);

		expect(upsertSkillCapability).toHaveBeenCalledWith(
			expect.objectContaining({ name: "described", description: "does a thing", surface: [...CROSS_SURFACE] }),
		);
	});
});

describe("pushAllSingleFile", () => {
	it("pushes only single-file skills when multi-file skills have no declaration", async () => {
		upsertSkillCapability.mockResolvedValue("created");
		makeLocalSkill("single-a", "a\n");
		makeMultiSkill("multi-b");

		const results = await pushAllSingleFile(home);

		expect(results.map((r) => r.name)).toEqual(["single-a"]);
		expect(upsertSkillCapability).toHaveBeenCalledTimes(1);
		expect(upsertSkillCapability).toHaveBeenCalledWith(expect.objectContaining({ name: "single-a" }));
	});

	it("pushes declared multi-file skills alongside single-file skills", async () => {
		upsertSkillCapability.mockResolvedValue("created");
		makeLocalSkill("single-x", "x\n");
		const dir = join(home, "multi-y");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\nname: multi-y\n---\ny\n");
		writeFileSync(join(dir, "ref.md"), "ref\n");
		writeFileSync(join(dir, "skill-sync.json"), JSON.stringify({ supporting_files: [{ path: "ref.md", travels: true }] }));

		const results = await pushAllSingleFile(home);

		expect(results.map((r) => r.name).sort()).toEqual(["multi-y", "single-x"]);
		expect(upsertSkillCapability).toHaveBeenCalledTimes(2);
	});
});

describe("pushByName", () => {
	it("returns a skipped outcome with 'no such local skill' when the name is unknown", async () => {
		const res = await pushByName("does-not-exist", home);

		expect(res.outcome).toBe("skipped");
		expect(res.reason).toBe("no such local skill");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("delegates to pushSkill for a known local skill", async () => {
		upsertSkillCapability.mockResolvedValueOnce("created");
		makeLocalSkill("known", "content\n");

		const res = await pushByName("known", home);

		expect(res.outcome).toBe("created");
		expect(getBaseHash(readSyncState(home), "known")).toBe(hashBody("content\n"));
	});
});

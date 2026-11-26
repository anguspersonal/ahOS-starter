import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashBody } from "./hash.js";

// Mocks the ahkms write path exactly as push.test.ts does, so the repo push's
// orchestration — the three refusals, the receipt stamp, the dry run — is
// exercised with no network or env. SkillKindConflictError is redefined here but
// is the same class repoPush.ts sees at runtime, since it imports it from this
// same mocked module.
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
	upsertSkillCapability: (...args: unknown[]) => upsertSkillCapability(...args),
	SkillKindConflictError,
}));

const { pushRepoSkills, hasConflictingHomeCopy, checkPushPreconditions } = await import("./repoPush.js");
const { readManifest } = await import("./repoManifest.js");
const { assembleSkillBody } = await import("./skillBody.js");

const BODY = "---\nname: dos-hl\ndescription: the ritual\n---\n\nDraft and stop.\n";
const REFERENCE = "# reference\n\nTaxonomies live here.\n";
const NOW = () => new Date("2026-08-21T12:00:00.000Z");

/** The body a skill carrying these files would serve — the receipt's subject. */
function assembled(files: Record<string, string>) {
	const result = assembleSkillBody(
		BODY,
		Object.entries(files).map(([path, content]) => ({ path, content })),
	);
	if (!result.ok) throw new Error(result.reason);
	return result;
}

/** `supporting_files` entry — a path plus its reviewed travel decision (#697). */
const decl = (path: string, travels: boolean) => ({ path, travels, why: "reviewed in the test" });

let repoRoot: string;
let skillsHome: string;

beforeEach(() => {
	repoRoot = mkdtempSync(join(tmpdir(), "repo-push-"));
	skillsHome = mkdtempSync(join(tmpdir(), "repo-push-home-"));
	mkdirSync(join(repoRoot, ".claude", "skills"), { recursive: true });
	upsertSkillCapability.mockReset();
	upsertSkillCapability.mockResolvedValue("updated");
});
afterEach(() => {
	rmSync(repoRoot, { recursive: true, force: true });
	rmSync(skillsHome, { recursive: true, force: true });
});

function writeSkill(name: string, body = BODY, extras: Record<string, string> = {}): void {
	const dir = join(repoRoot, ".claude", "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body, "utf8");
	for (const [rel, content] of Object.entries(extras)) {
		const target = join(dir, rel);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
}

function writeHomeCopy(name: string, body: string): void {
	mkdirSync(join(skillsHome, name), { recursive: true });
	writeFileSync(join(skillsHome, name, "SKILL.md"), body, "utf8");
}

/** A home copy with a supporting file alongside SKILL.md — tier `multi`. */
function writeMultiFileHomeCopy(name: string, body: string, extras: Record<string, string> = { "reference.md": "ref\n" }): void {
	mkdirSync(join(skillsHome, name), { recursive: true });
	writeFileSync(join(skillsHome, name, "SKILL.md"), body, "utf8");
	for (const [rel, content] of Object.entries(extras)) {
		const target = join(skillsHome, name, rel);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
}

function writeManifestFile(skills: Record<string, unknown>): void {
	writeFileSync(join(repoRoot, ".claude", "skill-registry.json"), JSON.stringify({ version: 1, skills }, null, "\t") + "\n", "utf8");
}

function enrolled(overrides: Record<string, unknown> = {}) {
	return {
		register: true,
		why: "portable ritual",
		surface: ["claude-code", "cowork", "chat"],
		supporting_files: [],
		body_sha256: hashBody(BODY),
		registered_at: null,
		...overrides,
	};
}

/**
 * Every test below is about push ORCHESTRATION, not about checkout currency, so
 * they declare a current checkout and never shell out to git. Without this the
 * fixture repo is a bare tmpdir, the real check reports "not a git repository",
 * and each result set gains a `(checkout)` warning that has nothing to do with
 * what the test is asserting. The currency gate itself is exercised in
 * repoPushCheckout.test.ts.
 */
const CURRENT = { currency: "current" as const, behind: 0, upstream: "origin/dev" };
const run = (only?: string, dryRun = false) =>
	pushRepoSkills(only, { repoRoot, skillsHome, dryRun, now: NOW, checkoutState: () => CURRENT });

describe("pushRepoSkills", () => {
	it("registers the enrolled skill's SKILL.md verbatim as a kms-db body and stamps the receipt", async () => {
		writeSkill("dos-hl");
		writeManifestFile({ "dos-hl": enrolled() });

		const results = await run();

		expect(results).toEqual([{ name: "dos-hl", outcome: "updated" }]);
		expect(upsertSkillCapability).toHaveBeenCalledWith({
			name: "dos-hl",
			description: "the ritual",
			body: BODY,
			surface: ["claude-code", "cowork", "chat"],
			repoMirror: ".claude/skills/dos-hl/SKILL.md",
		});
		const entry = readManifest(join(repoRoot, ".claude", "skill-registry.json")).skills["dos-hl"];
		expect(entry.registered_at).toBe("2026-08-21T12:00:00.000Z");
		expect(entry.body_sha256).toBe(hashBody(BODY));
	});

	it("refuses when the manifest hash does not match the file — pushing unreviewed bytes is the same surprise in reverse", async () => {
		writeSkill("dos-hl");
		writeManifestFile({ "dos-hl": enrolled({ body_sha256: "stale" }) });

		const [result] = await run();

		expect(result.outcome).toBe("skipped");
		expect(result.reason).toMatch(/does not match the assembled body/);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("refuses when supporting files changed since their travel decisions were reviewed", async () => {
		writeSkill("dos-hl", BODY, { "references/new.md": "now load-bearing\n" });
		writeManifestFile({ "dos-hl": enrolled() });

		const [result] = await run();

		expect(result.outcome).toBe("skipped");
		expect(result.reason).toMatch(/supporting files changed/);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	// The acceptance criterion of #697: dos-infra and dos-personal are shaped
	// exactly like this, and were held at register: false because of it.
	it("carries a travelling supporting file inside the pushed body", async () => {
		writeSkill("dos-infra", BODY, { "references/REFERENCE.md": REFERENCE });
		const expected = assembled({ "references/REFERENCE.md": REFERENCE });
		writeManifestFile({
			"dos-infra": enrolled({ supporting_files: [decl("references/REFERENCE.md", true)], body_sha256: expected.hash }),
		});

		const [result] = await run();

		expect(result.outcome).toBe("updated");
		const pushed = upsertSkillCapability.mock.calls[0][0].body as string;
		expect(pushed).toBe(expected.body);
		expect(pushed).toContain("Taxonomies live here.");
		expect(pushed).toContain("## `references/REFERENCE.md`");
	});

	it("leaves a non-travelling supporting file out of the body, so a single-file skill is unchanged", async () => {
		writeSkill("dos-hl", BODY, { "references/example.json": "{}\n" });
		writeManifestFile({ "dos-hl": enrolled({ supporting_files: [decl("references/example.json", false)] }) });

		const [result] = await run();

		expect(result.outcome).toBe("updated");
		expect(upsertSkillCapability.mock.calls[0][0].body).toBe(BODY);
	});

	it("refuses, naming the skill, when a travelling file changed but the receipt did not", async () => {
		writeSkill("dos-infra", BODY, { "references/REFERENCE.md": `${REFERENCE}and a new rule\n` });
		writeManifestFile({
			"dos-infra": enrolled({
				supporting_files: [decl("references/REFERENCE.md", true)],
				body_sha256: assembled({ "references/REFERENCE.md": REFERENCE }).hash,
			}),
		});

		const [result] = await run();

		expect(result.name).toBe("dos-infra");
		expect(result.outcome).toBe("skipped");
		expect(result.reason).toMatch(/does not match the assembled body \(SKILL\.md \+ references\/REFERENCE\.md\)/);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("refuses, naming the skill, when a travelling file is not text", async () => {
		writeSkill("dos-infra");
		writeFileSync(join(repoRoot, ".claude", "skills", "dos-infra", "logo.png"), Buffer.from([0x89, 0x00, 0x01]));
		writeManifestFile({ "dos-infra": enrolled({ supporting_files: [decl("logo.png", true)] }) });

		const [result] = await run();

		expect(result).toMatchObject({ name: "dos-infra", outcome: "skipped" });
		expect(result.reason).toMatch(/body cannot be assembled/);
		expect(result.reason).toContain("logo.png");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	it("refuses when the skills home holds a copy of the name with different bytes", async () => {
		writeSkill("dogfood");
		writeHomeCopy("dogfood", "a different fork\n");
		writeManifestFile({ dogfood: enrolled() });

		const [result] = await run();

		expect(result.outcome).toBe("skipped");
		expect(result.reason).toMatch(/DIFFERENT copy/);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	// #707: the manifest is free to declare a surface narrower than CROSS_SURFACE
	// (six of the eight enrolled skills do), and the home push always writes
	// CROSS_SURFACE. A same-bytes home copy — the obvious way in is a symlink —
	// must not be waved through just because the body check alone would pass it.
	it("refuses when the skills home holds identical bytes but the manifest declares a narrower surface", async () => {
		writeSkill("route");
		writeHomeCopy("route", BODY);
		writeManifestFile({ route: enrolled({ surface: ["claude-code"] }) });

		const [result] = await run();

		expect(result.outcome).toBe("skipped");
		expect(result.reason).toMatch(/disagree on surface/);
		expect(result.reason).toContain("surface=[claude-code, cowork, chat]");
		expect(result.reason).toContain("surface=[claude-code]");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});

	// The home tree symlinks several entries into this repo, so the same file is
	// visible from both sources. Pushing either lands the same body, and a
	// path-based test gets this wrong from a git worktree — where the symlink
	// resolves to the main checkout, not the tree being pushed.
	it("does not refuse when the home copy holds identical bytes", async () => {
		writeSkill("capture");
		writeHomeCopy("capture", BODY);
		writeManifestFile({ capture: enrolled() });

		const [result] = await run();

		expect(result.outcome).toBe("updated");
	});

	it("ignores whitespace-only differences between the two copies, matching the canonical hash", async () => {
		writeSkill("capture");
		writeHomeCopy("capture", BODY.replace(/\n$/, "  \n\n\n"));
		writeManifestFile({ capture: enrolled() });

		expect((await run())[0].outcome).toBe("updated");
	});

	it("skips rather than clobbers when the name is already an agent or command", async () => {
		writeSkill("dos-hl");
		writeManifestFile({ "dos-hl": enrolled() });
		upsertSkillCapability.mockRejectedValueOnce(new SkillKindConflictError("dos-hl", "agent"));

		const [result] = await run();

		expect(result).toEqual({ name: "dos-hl", outcome: "skipped", reason: "already registered as agent — not overwriting" });
	});

	it("dry-run touches neither ahkms nor the manifest", async () => {
		writeSkill("dos-hl");
		writeManifestFile({ "dos-hl": enrolled() });
		const before = readFileSync(join(repoRoot, ".claude", "skill-registry.json"), "utf8");

		const [result] = await run(undefined, true);

		expect(result.outcome).toBe("would-push");
		expect(upsertSkillCapability).not.toHaveBeenCalled();
		expect(readFileSync(join(repoRoot, ".claude", "skill-registry.json"), "utf8")).toBe(before);
	});

	it("skips a not-enrolled skill asked for by name, quoting the recorded reason", async () => {
		writeSkill("dogfood");
		writeManifestFile({ dogfood: { register: false, why: "forked against the home tree" } });

		const [result] = await run("dogfood");

		expect(result.outcome).toBe("skipped");
		expect(result.reason).toMatch(/forked against the home tree/);
	});

	it("pushes only enrolled skills when run over the whole manifest", async () => {
		writeSkill("dos-hl");
		writeSkill("dogfood");
		writeManifestFile({ "dos-hl": enrolled(), dogfood: { register: false, why: "forked" } });

		const results = await run();

		expect(results.map((result) => result.name)).toEqual(["dos-hl"]);
	});

	// End-to-end regression for the round-1 finding: an enrolled multi-file
	// skill (create-task's real shape) whose home entry is a SYMLINK into the
	// repo tree — same bytes, narrower manifest surface — must still push,
	// because push.ts's own writers never touch surface for a multi-file home
	// copy regardless of what the manifest declares.
	it("pushes an enrolled multi-file skill whose home copy is a symlink with a narrower declared surface", async () => {
		writeSkill("create-task", BODY, { "references/notion-integration.example.json": REFERENCE });
		symlinkSync(join(repoRoot, ".claude", "skills", "create-task"), join(skillsHome, "create-task"));
		writeManifestFile({
			"create-task": enrolled({
				surface: ["claude-code"],
				supporting_files: [decl("references/notion-integration.example.json", true)],
				body_sha256: assembled({ "references/notion-integration.example.json": REFERENCE }).hash,
			}),
		});

		const [result] = await run();

		expect(result).toMatchObject({ name: "create-task", outcome: "updated" });
		expect(upsertSkillCapability).toHaveBeenCalledWith(expect.objectContaining({ name: "create-task", surface: ["claude-code"] }));
	});
});

describe("hasConflictingHomeCopy", () => {
	const CROSS_SURFACE = ["claude-code", "cowork", "chat"];

	it("is null when the home has no such skill", () => {
		expect(hasConflictingHomeCopy("dos-hl", skillsHome, hashBody(BODY), CROSS_SURFACE)).toBeNull();
	});

	it("is null when the home entry has no SKILL.md at all", () => {
		mkdirSync(join(skillsHome, "dos-hl"), { recursive: true });
		expect(hasConflictingHomeCopy("dos-hl", skillsHome, hashBody(BODY), CROSS_SURFACE)).toBeNull();
	});

	it("names a conflict when the bytes differ, regardless of surface", () => {
		writeHomeCopy("dos-hl", "other\n");
		expect(hasConflictingHomeCopy("dos-hl", skillsHome, hashBody(BODY), CROSS_SURFACE)).toMatch(/DIFFERENT copy/);
	});

	// Same bytes + same surface: the two writers agree, so pushing either is
	// genuinely idempotent and there is nothing to refuse.
	it("is null when the bytes AND the declared surface match", () => {
		writeHomeCopy("dos-hl", BODY);
		expect(hasConflictingHomeCopy("dos-hl", skillsHome, hashBody(BODY), CROSS_SURFACE)).toBeNull();
	});

	// Same bytes + different surface: the case #707 was filed about. The body
	// check alone waves this through; the guard must not.
	it("names the conflict, with both surface lists, when the bytes match but the declared surface does not", () => {
		writeHomeCopy("dos-hl", BODY);
		const reason = hasConflictingHomeCopy("dos-hl", skillsHome, hashBody(BODY), ["claude-code"]);
		expect(reason).toMatch(/disagree on surface/);
		expect(reason).toContain("surface=[claude-code, cowork, chat]");
		expect(reason).toContain("surface=[claude-code]");
	});

	it("is order-insensitive when comparing surface lists", () => {
		writeHomeCopy("dos-hl", BODY);
		expect(hasConflictingHomeCopy("dos-hl", skillsHome, hashBody(BODY), ["chat", "claude-code", "cowork"])).toBeNull();
	});

	// The reviewer's #707-regression finding: push.ts's own writers (pushSkill /
	// pushAllSingleFile) skip any home copy whose tier is not `single` without
	// ever calling upsertSkillCapability, so a same-bytes MULTI-FILE home copy —
	// create-task and the issue's dos-infra/dos-personal example — is never at
	// risk of a real surface flip-flop. Same bytes + multi-file home copy +
	// narrower declared surface must not be reported as a conflict.
	it("is null when the bytes match, the home copy is multi-file, and the declared surface is narrower", () => {
		writeMultiFileHomeCopy("dos-hl", BODY);
		expect(hasConflictingHomeCopy("dos-hl", skillsHome, hashBody(BODY), ["claude-code"])).toBeNull();
	});

	it("is null when the home copy is multi-file even if its SKILL.md bytes differ from the repo copy", () => {
		writeMultiFileHomeCopy("dos-hl", "stale-home-body\n");
		expect(hasConflictingHomeCopy("dos-hl", skillsHome, hashBody(BODY), ["claude-code"])).toBeNull();
	});
});

describe("checkPushPreconditions", () => {
	const skill = {
		name: "x",
		dir: "",
		skillMd: BODY,
		description: null,
		skillMdHash: hashBody(BODY),
		supportingFiles: ["a.md"],
	};
	const resolved = assembled({});

	it("reports a missing skill directory before anything else", () => {
		expect(checkPushPreconditions(undefined, { body_sha256: "h", supporting_files: [] }, undefined, null)).toMatch(/no such skill/);
	});

	it("passes when the hash, the supporting files and the home tree all agree", () => {
		const entry = { body_sha256: resolved.hash, supporting_files: [decl("a.md", false)] };
		expect(checkPushPreconditions(skill, entry, resolved, null)).toBeNull();
	});

	it("surfaces the home-conflict reason verbatim, whatever hasConflictingHomeCopy named", () => {
		const entry = { body_sha256: resolved.hash, supporting_files: [decl("a.md", false)] };
		expect(checkPushPreconditions(skill, entry, resolved, "writers disagree on surface")).toBe("writers disagree on surface");
	});

	// Order matters: the file-set check is what proves a declared travelling path
	// exists, so it has to run before anything tries to assemble a body from one.
	it("reports the drifted file set before the body, not after", () => {
		const entry = { body_sha256: resolved.hash, supporting_files: [] };
		expect(checkPushPreconditions(skill, entry, undefined, null)).toMatch(/supporting files changed/);
	});
});

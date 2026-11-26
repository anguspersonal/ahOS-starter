import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBody } from "./hash.js";
import { listRepoSkills, resolveSkillBody } from "./repoSkills.js";

// The repo source enumerates .claude/skills/<name>/SKILL.md (#689). The two
// load-bearing properties: the SKILL.md hash must be the SAME canonical hash the
// home-tree path uses (otherwise the home-copy conflict guard never agrees), and
// supportingFiles must report the real tree, since a skill's supporting files
// being unchanged is what the manifest affirms.
//
// resolveSkillBody is the fs half of #697: it reads the declared travelling files
// and hands them to the pure assembler. Every failure returns a reason naming the
// file — a body that quietly lost a reference is the failure this all exists to
// prevent.

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "repo-skills-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeSkill(name: string, body: string, extras: Record<string, string> = {}): void {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body, "utf8");
	for (const [rel, content] of Object.entries(extras)) {
		const target = join(dir, rel);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
}

describe("listRepoSkills", () => {
	it("returns an empty list when the tree does not exist", () => {
		expect(listRepoSkills(join(root, "nope"))).toEqual([]);
	});

	it("reads SKILL.md verbatim and hashes it with the shared canonical hash", () => {
		const body = "---\nname: dos-hl\ndescription: ritual\n---\n\nStep one.\n";
		makeSkill("dos-hl", body);

		const [skill] = listRepoSkills(root);
		expect(skill.name).toBe("dos-hl");
		expect(skill.skillMd).toBe(body);
		expect(skill.description).toBe("ritual");
		expect(skill.skillMdHash).toBe(hashBody(body));
	});

	it("lists non-SKILL.md files as supporting files, nested paths included, dotfiles excluded", () => {
		makeSkill("dos-hl", "---\nname: dos-hl\n---\nbody\n", {
			"references/notion.example.json": "{}\n",
			".DS_Store": "junk",
		});

		const [skill] = listRepoSkills(root);
		expect(skill.supportingFiles).toEqual(["references/notion.example.json"]);
	});

	it("skips directories with no SKILL.md and sorts by name", () => {
		makeSkill("route", "---\nname: route\n---\nb\n");
		makeSkill("afk", "---\nname: afk\n---\nb\n");
		mkdirSync(join(root, "references"), { recursive: true });
		writeFileSync(join(root, "references", "notes.md"), "x\n", "utf8");

		expect(listRepoSkills(root).map((skill) => skill.name)).toEqual(["afk", "route"]);
	});

	it("carries a null description when the frontmatter has none", () => {
		makeSkill("bare", "no frontmatter at all\n");
		expect(listRepoSkills(root)[0].description).toBeNull();
	});
});

describe("resolveSkillBody", () => {
	const SKILL = "---\nname: dos-infra\n---\n\n1. Read `references/REFERENCE.md`.\n";

	it("serves SKILL.md verbatim when nothing travels", () => {
		makeSkill("dos-infra", SKILL, { "references/REFERENCE.md": "taxonomies\n" });
		const result = resolveSkillBody(listRepoSkills(root)[0], []);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body).toBe(SKILL);
		expect(result.hash).toBe(hashBody(SKILL));
	});

	it("reads each travelling file off disk and carries it in the body", () => {
		makeSkill("dos-infra", SKILL, { "references/REFERENCE.md": "# taxonomies\n" });
		const result = resolveSkillBody(listRepoSkills(root)[0], ["references/REFERENCE.md"]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.carried).toEqual(["references/REFERENCE.md"]);
		expect(result.body).toContain("## `references/REFERENCE.md`");
		expect(result.body).toContain("# taxonomies");
	});

	it("re-hashes when a travelling file changes — the drift a receipt on SKILL.md alone would miss", () => {
		makeSkill("dos-infra", SKILL, { "references/REFERENCE.md": "before\n" });
		const before = resolveSkillBody(listRepoSkills(root)[0], ["references/REFERENCE.md"]);
		makeSkill("dos-infra", SKILL, { "references/REFERENCE.md": "after\n" });
		const after = resolveSkillBody(listRepoSkills(root)[0], ["references/REFERENCE.md"]);

		expect(before.ok && after.ok && before.hash === after.hash).toBe(false);
	});

	it("refuses by name when a declared travelling file is not on disk", () => {
		makeSkill("dos-infra", SKILL);
		const result = resolveSkillBody(listRepoSkills(root)[0], ["references/REFERENCE.md"]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("references/REFERENCE.md");
		expect(result.reason).toContain("could not be read");
	});

	it("refuses a binary file rather than carrying mojibake into an authoritative body", () => {
		makeSkill("dos-infra", SKILL);
		writeFileSync(join(root, "dos-infra", "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
		const result = resolveSkillBody(listRepoSkills(root)[0], ["logo.png"]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("logo.png");
	});

	it("refuses a declared travelling file that escapes the skill directory (path traversal)", () => {
		makeSkill("dos-infra", SKILL);
		writeFileSync(join(root, "secret.txt"), "private\n", "utf8");
		const result = resolveSkillBody(listRepoSkills(root)[0], ["../secret.txt"]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("escapes the skill's own directory");
		expect(result.reason).toContain("../secret.txt");
	});
});

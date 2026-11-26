import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashBody } from "./hash.js";
import { MAX_BODY_BYTES, assembleSkillBody, assertWithinSkillDir, injectBundlePointer, uncarriableReason, unterminatedOpener } from "./skillBody.js";

// The bundle format (#697). Two properties carry the whole design:
//   1. With nothing to carry, assembly is the IDENTITY function — every receipt
//      stamped before #697 stays valid, and single-file skills are untouched.
//   2. With something to carry, the body is a deterministic function of the
//      files, so the credential-free guard can rebuild and re-hash it — which is
//      what makes a changed REFERENCE.md fail exactly like a changed SKILL.md.

const SKILL = "---\nname: dos-infra\n---\n\n1. Read `references/REFERENCE.md`.\n";
const REFERENCE = "# dos-infra reference\n\n- `Bug`\n- `Question`\n";

const ok = (result: ReturnType<typeof assembleSkillBody>) => {
	if (!result.ok) throw new Error(`expected an assembled body, got refusal: ${result.reason}`);
	return result;
};

describe("assembleSkillBody with nothing to carry", () => {
	it("is the identity function on SKILL.md, byte for byte", () => {
		const result = ok(assembleSkillBody(SKILL, []));
		expect(result.body).toBe(SKILL);
		expect(result.carried).toEqual([]);
	});

	it("hashes to the plain SKILL.md hash, so receipts stamped before #697 still match", () => {
		expect(ok(assembleSkillBody(SKILL, [])).hash).toBe(hashBody(SKILL));
	});

	it("does not canonicalise — a body already registered must not change bytes", () => {
		const ragged = "a\r\nb   \n\n\n";
		expect(ok(assembleSkillBody(ragged, [])).body).toBe(ragged);
	});
});

describe("assembleSkillBody with files to carry", () => {
	const carried = () => ok(assembleSkillBody(SKILL, [{ path: "references/REFERENCE.md", content: REFERENCE }]));

	it("keeps the frontmatter at byte 0 and appends the file under its own path as a heading", () => {
		const body = carried().body;
		expect(body.indexOf("---\n")).toBe(0);
		expect(body.startsWith("---\nname: dos-infra\n---")).toBe(true);
		expect(body).toContain("## `references/REFERENCE.md`");
		expect(body).toContain("# dos-infra reference");
	});

	it("tells the surface to read the section instead of the path — the whole contract", () => {
		const body = carried().body;
		expect(body).toContain("read the section with that exact heading below instead");
		expect(body).toContain("Do not try to open them on disk");
	});

	// #727: a surface that executes step 1 as it reads it must learn the
	// appendix exists BEFORE it reaches that instruction — which sits right
	// after the frontmatter in SKILL.md, ahead of "Read `references/REFERENCE.md`."
	it("inserts a pointer to the appendix right after the frontmatter, before the instruction that needs it", () => {
		const body = carried().body;
		const pointerIndex = body.indexOf("This file travels with its supporting files carried below");
		const instructionIndex = body.indexOf("Read `references/REFERENCE.md`.");
		const closingFrontmatterIndex = body.indexOf("---", 4); // after the opening "---\n"
		expect(pointerIndex).toBeGreaterThan(-1);
		expect(instructionIndex).toBeGreaterThan(-1);
		expect(pointerIndex).toBeGreaterThan(closingFrontmatterIndex);
		expect(pointerIndex).toBeLessThan(instructionIndex);
	});

	it("lists exactly what it carries, so a surface can tell a missing file from a complete bundle", () => {
		const body = carried().body;
		expect(body).toContain("Carried in this body (1):\n- `references/REFERENCE.md`");
		expect(body).toContain("This list is complete for what is CARRIED in this body");
		expect(carried().carried).toEqual(["references/REFERENCE.md"]);
	});

	// #728: a mixed skill (some travels: true, some travels: false) must not
	// have its non-carried siblings read as absent — they are present, just
	// reviewed as out of scope.
	describe("with a sibling file that does not travel", () => {
		const mixed = () =>
			ok(
				assembleSkillBody(
					SKILL,
					[{ path: "references/REFERENCE.md", content: REFERENCE }],
					["references/example.json"],
				),
			);

		it("names the sibling as present but not carried, rather than omitting it", () => {
			const body = mixed().body;
			expect(body).toContain("Present in the skill's directory but not carried in this body (1):\n- `references/example.json`");
		});

		it("does not claim completeness for the whole directory", () => {
			const body = mixed().body;
			expect(body).not.toContain("This list is complete for the skill's own directory");
			expect(body).toContain("This list is complete for what is CARRIED in this body — not for the skill's whole");
		});

		it("says nothing about siblings when every supporting file travels", () => {
			expect(carried().body).not.toContain("Present in the skill's directory but not carried");
		});

		it("carried paths stay unaffected by which siblings are named", () => {
			expect(mixed().carried).toEqual(["references/REFERENCE.md"]);
		});
	});

	it("hashes differently from SKILL.md alone — this is what catches a changed REFERENCE.md", () => {
		expect(carried().hash).not.toBe(hashBody(SKILL));
		const edited = ok(assembleSkillBody(SKILL, [{ path: "references/REFERENCE.md", content: `${REFERENCE}- \`New\`\n` }]));
		expect(edited.hash).not.toBe(carried().hash);
	});

	it("is deterministic: path order in, path order out", () => {
		const files = [
			{ path: "b.md", content: "bee\n" },
			{ path: "a.md", content: "ay\n" },
		];
		const forwards = ok(assembleSkillBody(SKILL, files));
		const backwards = ok(assembleSkillBody(SKILL, [...files].reverse()));
		expect(forwards.body).toBe(backwards.body);
		expect(forwards.carried).toEqual(["a.md", "b.md"]);
		expect(forwards.body.indexOf("## `a.md`")).toBeLessThan(forwards.body.indexOf("## `b.md`"));
	});

	it("canonicalises carried content, so a CRLF checkout assembles the same bytes as an LF one", () => {
		const lf = ok(assembleSkillBody(SKILL, [{ path: "r.md", content: "one\ntwo\n" }]));
		const crlf = ok(assembleSkillBody(SKILL, [{ path: "r.md", content: "one\r\ntwo   \r\n\r\n" }]));
		expect(crlf.body).toBe(lf.body);
	});

	it("opens a fence the content cannot close early", () => {
		const withFence = "Example:\n\n```json\n{}\n```\n";
		const body = ok(assembleSkillBody(SKILL, [{ path: "r.md", content: withFence }])).body;
		expect(body).toContain("````\nExample:");
		expect(body.trimEnd().endsWith("````")).toBe(true);
	});

	// #727: two no-op branches (documented in the function's own comment) plus the
	// ordinary insertion point, exercised directly rather than only indirectly
	// through assembleSkillBody's one always-well-formed fixture.
	describe("injectBundlePointer", () => {
		it("is a no-op when there is no opening frontmatter fence", () => {
			const text = "# Just a heading\n\nNo frontmatter here.\n";
			expect(injectBundlePointer(text)).toBe(text);
		});

		it("is a no-op when the frontmatter opens but never closes", () => {
			const text = "---\nname: dos-infra\n\n1. Read `references/REFERENCE.md`.\n";
			expect(injectBundlePointer(text)).toBe(text);
		});

		it("inserts the pointer with a blank line on each side, even with no blank line after the closing fence", () => {
			const text = "---\nname: dos-infra\n---\n1. Read `references/REFERENCE.md`.\n";
			const result = injectBundlePointer(text);
			const lines = result.split("\n");
			const closeIndex = lines.indexOf("---", 1);
			expect(closeIndex).toBeGreaterThan(-1);
			// blank line immediately after the closing fence, then the pointer, then
			// another blank line, before the instruction resumes.
			expect(lines[closeIndex + 1]).toBe("");
			expect(lines[closeIndex + 2]).toContain("This file travels with its supporting files carried below");
			const pointerEnd = lines.indexOf("", closeIndex + 2);
			expect(lines[pointerEnd]).toBe("");
			expect(lines[pointerEnd + 1]).toBe("1. Read `references/REFERENCE.md`.");
		});
	});
});

describe("refusals — nothing is ever silently dropped or cut", () => {
	it("refuses an over-budget body and names the byte counts rather than truncating", () => {
		const huge = `${"x".repeat(MAX_BODY_BYTES)}\n`;
		const result = assembleSkillBody(SKILL, [{ path: "big.md", content: huge }]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("over the 262144-byte budget");
		expect(result.reason).toContain("big.md");
		expect(result.reason).toContain("never truncated");
	});

	it("accepts a body right up to the budget", () => {
		const body = ok(assembleSkillBody("x".repeat(MAX_BODY_BYTES - 1), []));
		expect(body.bytes).toBe(MAX_BODY_BYTES); // canonicalize adds the trailing newline
	});

	// This repo is developed on Windows with autocrlf and CI runs on Linux, so a
	// budget measured on raw bytes would differ between them by the line count.
	it("measures the canonical form, so a CRLF checkout and CI agree", () => {
		const lines = "line\n".repeat(1000);
		expect(ok(assembleSkillBody(lines, [])).bytes).toBe(ok(assembleSkillBody(lines.replace(/\n/g, "\r\n"), [])).bytes);
	});

	it("counts UTF-8 bytes, not characters — a multi-byte body must not slip past the budget", () => {
		const result = assembleSkillBody("é".repeat(MAX_BODY_BYTES / 2 + 1), []);
		expect(result.ok).toBe(false);
	});

	// SKILL.md is the ONE part of a body that is not fence-wrapped: `fenceFor`
	// protects every carried file, but nothing protects the skill's own markdown.
	// A construct left open at its end therefore swallows the whole appendix —
	// the preamble and every carried section become quoted text — which is the
	// same silent corruption as a fence that closes early, from the other side.
	describe("an unterminated opener in SKILL.md, which would swallow the appendix", () => {
		const carrying = (skillMd: string) => assembleSkillBody(skillMd, [{ path: "references/REFERENCE.md", content: REFERENCE }]);

		it.each([
			["a backtick code fence", "# Skill\n\n```json\n{}\n"],
			["a tilde code fence", "# Skill\n\n~~~\nexample\n"],
			["a longer fence a shorter one cannot close", "# Skill\n\n````\n```\n"],
			["an HTML comment", "# Skill\n\n<!-- note to self\n"],
			["a `<pre>` block", "# Skill\n\n<pre>\nexample\n"],
		])("refuses when SKILL.md ends inside %s", (_label, skillMd) => {
			const result = carrying(skillMd);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.reason).toContain("would swallow the appendix");
			expect(result.reason).toContain("references/REFERENCE.md");
		});

		it.each([
			["a closed fence", "# Skill\n\n```json\n{}\n```\n"],
			["a fence closed by a longer one", "# Skill\n\n```\n{}\n`````\n"],
			["a closed HTML comment", "# Skill\n\n<!-- note -->\n"],
			["a one-line `<pre>` block", "# Skill\n\n<pre>example</pre>\n"],
			["a declaration", "# Skill\n\n<!DOCTYPE html>\n"],
			["an inline code span at line start", "# Skill\n\n``` `x` ``` is a span\n"],
			["a fence opened INSIDE a carried-looking block but closed", "# Skill\n\n~~~\n```\n~~~\n"],
		])("assembles normally with %s", (_label, skillMd) => {
			expect(carrying(skillMd).ok).toBe(true);
		});

		it("does not apply when nothing travels — the identity guarantee holds whatever the markdown does", () => {
			const ragged = "# Skill\n\n```json\n{}\n";
			expect(ok(assembleSkillBody(ragged, [])).body).toBe(ragged);
			expect(unterminatedOpener(ragged)).not.toBeNull();
		});

		it("says null for ordinary, balanced markdown", () => {
			expect(unterminatedOpener(SKILL)).toBeNull();
			expect(unterminatedOpener(REFERENCE)).toBeNull();
		});
	});

	it("refuses a non-text file by name rather than carrying mojibake", () => {
		expect(uncarriableReason("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]))).toContain("logo.png");
		expect(uncarriableReason("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]))).toContain("NUL");
	});

	it("carries ordinary text", () => {
		expect(uncarriableReason("r.md", Buffer.from(REFERENCE, "utf8"))).toBeNull();
	});
});

describe("assertWithinSkillDir", () => {
	const skillDir = "/fake/skills/my-skill";

	it("accepts a normal relative path within the skill directory", () => {
		const res = assertWithinSkillDir(skillDir, "references/REFERENCE.md");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.fullPath).toBe(path.resolve(skillDir, "references/REFERENCE.md"));
	});

	it("accepts a nested relative path with redundant dot segments that remains inside", () => {
		const res = assertWithinSkillDir(skillDir, "./subdir/../doc.txt");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.fullPath).toBe(path.resolve(skillDir, "doc.txt"));
	});

	it("refuses a path that escapes the skill directory via parent segments", () => {
		const res = assertWithinSkillDir(skillDir, "../other-skill/file.txt");
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toContain("escapes the skill's own directory");
		expect(res.reason).toContain("../other-skill/file.txt");
	});

	it("refuses a root escape like ../../../etc/passwd", () => {
		const res = assertWithinSkillDir(skillDir, "../../../etc/passwd");
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toContain("escapes the skill's own directory");
	});
});

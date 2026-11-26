import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectTier } from "./tier.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "skill-tier-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("detectTier", () => {
	it("classifies a lone SKILL.md as single-file", () => {
		writeFileSync(join(dir, "SKILL.md"), "body");
		const r = detectTier(dir);
		expect(r.tier).toBe("single");
		expect(r.fileCount).toBe(1);
		expect(r.hasSkillMd).toBe(true);
	});

	it("classifies SKILL.md plus a reference as multi-file", () => {
		writeFileSync(join(dir, "SKILL.md"), "body");
		mkdirSync(join(dir, "references"));
		writeFileSync(join(dir, "references", "a.md"), "ref");
		const r = detectTier(dir);
		expect(r.tier).toBe("multi");
		expect(r.fileCount).toBe(2);
		expect(r.files).toContain("references/a.md");
	});

	it("ignores dotfiles so junk does not flip the tier", () => {
		writeFileSync(join(dir, "SKILL.md"), "body");
		writeFileSync(join(dir, ".DS_Store"), "junk");
		const r = detectTier(dir);
		expect(r.tier).toBe("single");
		expect(r.fileCount).toBe(1);
	});

	it("is multi-file when there is no SKILL.md but other files exist", () => {
		writeFileSync(join(dir, "notes.md"), "x");
		const r = detectTier(dir);
		expect(r.tier).toBe("multi");
		expect(r.hasSkillMd).toBe(false);
	});
});

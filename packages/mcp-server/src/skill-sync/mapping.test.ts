import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitBlobHash } from "./gitBlob.js";
import { mapFork, suggestForkMappings } from "./mapping.js";
import type { Upstream } from "./upstream.js";
import { parseXUpstream } from "./xUpstream.js";

let root: string;
let skillsHome: string;
let upstream: Upstream;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "skill-map-"));
	skillsHome = join(root, "home");
	const clone = join(root, "clone");

	// upstream skill "to-tickets" (mapFork reads files only — no git needed here)
	const ut = join(clone, "skills", "engineering", "to-tickets");
	mkdirSync(ut, { recursive: true });
	writeFileSync(join(ut, "SKILL.md"), "---\nname: to-tickets\n---\nbreak a plan into tracer bullet vertical slices tickets\n");

	// local fork "to-issues" — drifted name, similar body
	mkdirSync(join(skillsHome, "to-issues"), { recursive: true });
	writeFileSync(
		join(skillsHome, "to-issues", "SKILL.md"),
		"---\nname: to-issues\ndescription: d\n---\nbreak a plan into tracer bullet vertical slices issues\n",
	);
	// an unrelated local skill
	mkdirSync(join(skillsHome, "qa-review"), { recursive: true });
	writeFileSync(join(skillsHome, "qa-review", "SKILL.md"), "---\nname: qa-review\n---\nreview a pull request against the rubric\n");

	upstream = { name: "mp-skills", url: "https://github.com/mattpocock/skills", dir: clone };
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("suggestForkMappings", () => {
	it("floats the drifted fork above unrelated local skills", () => {
		const [s] = suggestForkMappings(upstream, skillsHome);
		expect(s.upstream).toBe("to-tickets");
		expect(s.local).toBe("to-issues");
	});
});

describe("mapFork", () => {
	it("stamps x-upstream on the local fork, pinned to the upstream HEAD + blob", () => {
		const res = mapFork(upstream, "to-tickets", "to-issues", "HEADSHA", "2026-07-15", skillsHome);
		const upstreamBody = readFileSync(join(root, "clone/skills/engineering/to-tickets/SKILL.md"), "utf8");
		expect(res.baseBlob).toBe(gitBlobHash(upstreamBody));

		const stamped = readFileSync(join(skillsHome, "to-issues", "SKILL.md"), "utf8");
		const x = parseXUpstream(stamped);
		expect(x?.repo).toBe(upstream.url);
		// POSIX-normalise: the stored path is built with path.join, so it uses
		// backslashes on Windows even though the value is logically a POSIX subpath.
		expect(x?.path?.replace(/\\/g, "/")).toBe("skills/engineering/to-tickets/SKILL.md");
		expect(x?.baseCommit).toBe("HEADSHA");
		// the local body is preserved — mapping records provenance, it doesn't overwrite content
		expect(stamped).toContain("slices issues");
	});

	it("throws when the local skill does not exist", () => {
		expect(() => mapFork(upstream, "to-tickets", "nope", "H", "2026-07-15", skillsHome)).toThrow(/not found/);
	});
});

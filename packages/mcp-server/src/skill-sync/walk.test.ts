import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitBlobHash } from "./gitBlob.js";
import { importUpstreamSkill } from "./import.js";
import { listUpstreamSkills, registerUpstream, upstreamHead } from "./upstream.js";
import { walkFork } from "./walk.js";
import { parseXUpstream } from "./xUpstream.js";

/**
 * The environment minus every `GIT_*` variable (#1056, #1064).
 *
 * `cwd` is not isolation: when `GIT_DIR` or `GIT_INDEX_FILE` are set (such as
 * during `git bisect run` or `git rebase -x`), git ignores `cwd` and operates
 * on the directory `GIT_DIR` names — re-initialising the real repository as
 * bare and committing test fixtures to whatever branch is checked out.
 */
function cleanGitEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!k.startsWith("GIT_")) env[k] = v;
	}
	return { ...env, ...extra };
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: cleanGitEnv(),
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

let root: string;
let upstreamRepo: string;
let skillsHome: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "skill-walk-")));
	upstreamRepo = join(root, "mp");
	skillsHome = join(root, "home");
	mkdirSync(skillsHome, { recursive: true });

	const impl = join(upstreamRepo, "skills", "implement");
	mkdirSync(impl, { recursive: true });
	writeFileSync(join(impl, "SKILL.md"), "---\nname: implement\n---\nline one\nline two\nline three\n");
	// NO `.gitattributes` pin here, deliberately. PR #391 pinned `* -text` to force
	// an LF checkout, because the LF-only frontmatter regexes corrupted the file
	// when the host git has core.autocrlf=true (the Windows default). That pin
	// masked the production bug — #392. Now that xUpstream.ts is CRLF-tolerant, the
	// clone is left to check out however the host git is configured, so on a Windows
	// dev box this suite exercises the real CRLF path end to end. Re-adding a pin
	// here would silently retire that coverage.
	git(["init", "-q", "-b", "main"], upstreamRepo);

	// Belt and braces: prove the fixture really is its own repository before
	// writing a single object into it (#1056, #1064).
	const toplevel = realpathSync(git(["rev-parse", "--show-toplevel"], upstreamRepo));
	expect(toplevel).toBe(realpathSync(upstreamRepo));

	git(["config", "user.email", "t@t"], upstreamRepo);
	git(["config", "user.name", "t"], upstreamRepo);
	git(["add", "-A"], upstreamRepo);
	git(["commit", "-qm", "v1"], upstreamRepo);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Register the upstream and import "implement" — gives it x-upstream + a cached base. */
function importImplement(): void {
	const up = registerUpstream(upstreamRepo, skillsHome);
	const impl = listUpstreamSkills(up.dir).find((s) => s.name === "implement")!;
	importUpstreamSkill(up, impl, upstreamHead(up.dir), "2026-07-15", skillsHome);
}

/** Rewrite the upstream skill, commit v2, and re-fetch the clone. */
function moveUpstream(body: string): void {
	writeFileSync(join(upstreamRepo, "skills", "implement", "SKILL.md"), body);
	git(["commit", "-aqm", "v2"], upstreamRepo);
	registerUpstream(upstreamRepo, skillsHome); // re-fetch into the clone
}

describe("walkFork", () => {
	it("is a no-op when upstream has not moved", () => {
		importImplement();
		expect(walkFork("implement", "2026-07-16", { apply: false }, skillsHome).outcome).toBe("unmoved");
	});

	it("merges a non-overlapping upstream change and advances the base on apply", () => {
		importImplement();
		const localMd = join(skillsHome, "implement", "SKILL.md");
		writeFileSync(localMd, readFileSync(localMd, "utf8") + "local extra\n"); // local diverges
		moveUpstream("---\nname: implement\n---\nLINE ONE CHANGED\nline two\nline three\n");

		expect(walkFork("implement", "2026-07-16", { apply: false }, skillsHome).outcome).toBe("merged");

		const applied = walkFork("implement", "2026-07-16", { apply: true }, skillsHome);
		expect(applied.outcome).toBe("merged");
		const merged = readFileSync(localMd, "utf8");
		expect(merged).toContain("LINE ONE CHANGED"); // upstream change taken
		expect(merged).toContain("local extra"); // local divergence kept
		const headSha = git(["rev-parse", "HEAD"], upstreamRepo);
		expect(parseXUpstream(merged)?.baseCommit).toBe(headSha);

		// after applying, a second walk sees no movement
		expect(walkFork("implement", "2026-07-16", { apply: false }, skillsHome).outcome).toBe("unmoved");
	});

	it("reports a conflict when local and upstream change the same region", () => {
		importImplement();
		const localMd = join(skillsHome, "implement", "SKILL.md");
		writeFileSync(localMd, readFileSync(localMd, "utf8").replace("line two", "LOCAL two"));
		moveUpstream("---\nname: implement\n---\nline one\nUPSTREAM two\nline three\n");
		const r = walkFork("implement", "2026-07-16", { apply: false }, skillsHome);
		expect(r.outcome).toBe("conflict");
		expect(r.conflicts).toBeGreaterThan(0);
	});

	it("recovers an uncached base from the upstream clone and caches it", () => {
		importImplement();
		// A fork mapped before the base cache existed (#376): the cache has no entry,
		// but the clone still holds the base blob.
		const localMd = join(skillsHome, "implement", "SKILL.md");
		const baseBlob = parseXUpstream(readFileSync(localMd, "utf8"))!.baseBlob;
		const cached = join(skillsHome, ".upstream", ".base-cache", baseBlob);
		rmSync(cached);
		writeFileSync(localMd, readFileSync(localMd, "utf8") + "local extra\n");
		moveUpstream("---\nname: implement\n---\nLINE ONE CHANGED\nline two\nline three\n");

		const r = walkFork("implement", "2026-10-13", { apply: true }, skillsHome);
		expect(r.outcome).toBe("merged");
		const merged = readFileSync(localMd, "utf8");
		expect(merged).toContain("LINE ONE CHANGED");
		expect(merged).toContain("local extra");
		expect(gitBlobHash(readFileSync(cached, "utf8"))).toBe(baseBlob); // re-cached, verified
	});

	it("returns no-base, warning against re-mapping, when the base is neither cached nor in the clone", () => {
		importImplement();
		const localMd = join(skillsHome, "implement", "SKILL.md");
		const x = parseXUpstream(readFileSync(localMd, "utf8"))!;
		const missing = "f".repeat(40); // well-formed, but no such object
		writeFileSync(localMd, readFileSync(localMd, "utf8").replace(x.baseBlob, missing));
		expect(parseXUpstream(readFileSync(localMd, "utf8"))?.baseBlob).toBe(missing);
		moveUpstream("---\nname: implement\n---\nLINE ONE CHANGED\nline two\nline three\n");
		const before = readFileSync(localMd, "utf8");

		const r = walkFork("implement", "2026-10-13", { apply: true }, skillsHome);
		expect(r.outcome).toBe("no-base");
		expect(r.reason).toMatch(/discards every unreviewed upstream change/);
		expect(readFileSync(localMd, "utf8")).toBe(before); // nothing written
		expect(existsSync(join(skillsHome, ".upstream", ".base-cache", missing))).toBe(false);
	});

	it("returns no-mapping for a skill without x-upstream", () => {
		mkdirSync(join(skillsHome, "orphan"), { recursive: true });
		writeFileSync(join(skillsHome, "orphan", "SKILL.md"), "---\nname: orphan\n---\nbody\n");
		expect(walkFork("orphan", "2026-07-16", { apply: false }, skillsHome).outcome).toBe("no-mapping");
	});
});

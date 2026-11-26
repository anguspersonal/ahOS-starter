import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitBlobHash } from "./gitBlob.js";
import { importUpstreamSkill } from "./import.js";
import { listUpstreamSkills, registerUpstream, upstreamHead, upstreamName } from "./upstream.js";
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
	root = realpathSync(mkdtempSync(join(tmpdir(), "skill-upstream-")));
	upstreamRepo = join(root, "mp-repo");
	skillsHome = join(root, "home");
	mkdirSync(skillsHome, { recursive: true });

	// A tiny fake upstream: a single-file skill carrying an agents/ adapter, and a
	// multi-file skill carrying a real scripts/ file.
	const impl = join(upstreamRepo, "skills", "engineering", "implement");
	mkdirSync(join(impl, "agents"), { recursive: true });
	writeFileSync(join(impl, "SKILL.md"), "---\nname: implement\ndescription: do the work\n---\n\nImplement it.\n");
	writeFileSync(join(impl, "agents", "openai.yaml"), "name: implement\n");

	const diag = join(upstreamRepo, "skills", "engineering", "diagnosing-bugs");
	mkdirSync(join(diag, "scripts"), { recursive: true });
	writeFileSync(join(diag, "SKILL.md"), "---\nname: diagnosing-bugs\ndescription: debug\n---\n\nDebug it.\n");
	writeFileSync(join(diag, "scripts", "loop.sh"), "#!/bin/sh\necho hi\n");

	git(["init", "-q", "-b", "main"], upstreamRepo);

	// Belt and braces: prove the fixture really is its own repository before
	// writing a single object into it (#1056, #1064).
	const toplevel = realpathSync(git(["rev-parse", "--show-toplevel"], upstreamRepo));
	expect(toplevel).toBe(realpathSync(upstreamRepo));

	git(["config", "user.email", "t@t"], upstreamRepo);
	git(["config", "user.name", "t"], upstreamRepo);
	git(["add", "-A"], upstreamRepo);
	git(["commit", "-qm", "seed"], upstreamRepo);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("upstreamName", () => {
	it("derives owner-repo from https and ssh urls", () => {
		expect(upstreamName("https://github.com/mattpocock/skills")).toBe("mattpocock-skills");
		expect(upstreamName("https://github.com/mattpocock/skills.git")).toBe("mattpocock-skills");
		expect(upstreamName("git@github.com:mattpocock/skills.git")).toBe("mattpocock-skills");
	});
});

describe("registerUpstream + listUpstreamSkills", () => {
	it("clones under .upstream/ and lists skills with adapter-aware file counts", () => {
		const up = registerUpstream(upstreamRepo, skillsHome);
		expect(existsSync(join(up.dir, ".git"))).toBe(true);
		expect(up.dir.startsWith(join(skillsHome, ".upstream"))).toBe(true);

		const skills = listUpstreamSkills(up.dir);
		expect(skills.map((s) => s.name)).toEqual(["diagnosing-bugs", "implement"]);
		expect(skills.find((s) => s.name === "implement")!.fileCount).toBe(1); // agents/ excluded
		expect(skills.find((s) => s.name === "diagnosing-bugs")!.fileCount).toBe(2); // SKILL.md + scripts/loop.sh
	});
});

describe("importUpstreamSkill", () => {
	it("imports single-file, strips agents/, stamps a resolvable x-upstream", () => {
		const up = registerUpstream(upstreamRepo, skillsHome);
		const impl = listUpstreamSkills(up.dir).find((s) => s.name === "implement")!;
		const head = upstreamHead(up.dir);
		const res = importUpstreamSkill(up, impl, head, "2026-07-15", skillsHome);

		expect(res.tier).toBe("single");
		expect(existsSync(join(skillsHome, "implement", "agents"))).toBe(false);

		const imported = readFileSync(join(skillsHome, "implement", "SKILL.md"), "utf8");
		const x = parseXUpstream(imported);
		expect(x?.repo).toBe(upstreamRepo);
		expect(x?.baseCommit).toBe(head);
		// base_blob equals the git blob of the ORIGINAL upstream SKILL.md
		expect(x?.baseBlob).toBe(gitBlobHash(readFileSync(join(up.dir, impl.path), "utf8")));

		// #392: a resolvable x-upstream is NOT sufficient evidence the import worked.
		// Under core.autocrlf=true the clone checks out CRLF; the old LF-only regex
		// missed that frontmatter and prepended a SECOND, LF block, demoting the real
		// one to body. parseXUpstream happily read the prepended block, so this test
		// passed green over a corrupt file. Assert well-formedness — exactly one
		// frontmatter block, and the upstream's own `name:` still inside it.
		const delimiters = imported.split(/\r?\n/).filter((l) => l === "---").length;
		expect(delimiters).toBe(2); // one opener, one closer
		expect(imported).toContain("name: implement");
		expect(imported.split(/\r?\n/).indexOf("---")).toBe(0); // frontmatter opens the file
	});

	it("imports multi-file, keeping scripts/", () => {
		const up = registerUpstream(upstreamRepo, skillsHome);
		const diag = listUpstreamSkills(up.dir).find((s) => s.name === "diagnosing-bugs")!;
		const res = importUpstreamSkill(up, diag, upstreamHead(up.dir), "2026-07-15", skillsHome);
		expect(res.tier).toBe("multi");
		expect(existsSync(join(skillsHome, "diagnosing-bugs", "scripts", "loop.sh"))).toBe(true);
	});

	it("refuses to clobber an existing local skill", () => {
		const up = registerUpstream(upstreamRepo, skillsHome);
		const impl = listUpstreamSkills(up.dir).find((s) => s.name === "implement")!;
		mkdirSync(join(skillsHome, "implement"), { recursive: true });
		expect(() => importUpstreamSkill(up, impl, "HEAD", "2026-07-15", skillsHome)).toThrow(/clobber/);
	});
});

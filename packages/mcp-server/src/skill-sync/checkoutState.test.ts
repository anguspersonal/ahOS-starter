import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeCheckoutState, describeCheckoutStateLine } from "./checkoutState.js";

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

/**
 * The stale-checkout detector (#724).
 *
 * These build REAL git repositories in a temp dir — a bare "remote" and two
 * clones — rather than mocking git. The bug being guarded against was precisely
 * that two things which looked consistent were both stale, so a test that
 * asserts against a fake git would be reproducing the original mistake in the
 * test suite: it would pass whether or not the command it claims to run is the
 * right one. Local file:// remotes mean no network.
 *
 * `runGit` injection is used only for the failure paths, which cannot be staged
 * with a real repo (a git binary that refuses to fetch).
 */

let dir: string;
const git = (args: string[], cwd: string) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: cleanGitEnv(),
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** A committer identity, so these tests do not depend on the machine's config. */
const IDENT = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

function commit(repo: string, file: string, content: string): void {
	writeFileSync(join(repo, file), content, "utf8");
	git(["add", "-A"], repo);
	git([...IDENT, "commit", "-q", "-m", `add ${file}`], repo);
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-state-")));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A bare remote plus one clone tracking it, with one commit in common. */
function scaffold(): { remote: string; clone: string } {
	const origin = join(dir, "origin");
	const remote = join(dir, "remote.git");
	mkdirSync(origin, { recursive: true });
	git(["init", "-q", "-b", "main", "."], origin);

	// Belt and braces: prove the fixture really is its own repository before
	// writing a single object into it (#1056, #1064).
	const originToplevel = realpathSync(git(["rev-parse", "--show-toplevel"], origin));
	expect(originToplevel).toBe(realpathSync(origin));

	commit(origin, "a.txt", "one\n");
	git(["init", "-q", "--bare", "-b", "main", remote], dir);
	git(["remote", "add", "origin", remote], origin);
	git(["push", "-q", "-u", "origin", "main"], origin);

	const clone = join(dir, "clone");
	git(["clone", "-q", remote, clone], dir);

	// Belt and braces: prove the clone really is its own repository before
	// writing a single object into it (#1056, #1064).
	const cloneToplevel = realpathSync(git(["rev-parse", "--show-toplevel"], clone));
	expect(cloneToplevel).toBe(realpathSync(clone));

	return { remote, clone };
}

describe("describeCheckoutState - against real repositories", () => {
	it("reports current when the clone has everything the upstream has", () => {
		const { clone } = scaffold();
		const state = describeCheckoutState(clone);
		expect(state.currency).toBe("current");
		expect(state.behind).toBe(0);
		expect(state.upstream).toBe("origin/main");
	});

	/**
	 * The #724 case itself: another tree pushes, this one has not pulled, and
	 * every existing check still reports health because the file and the receipt
	 * are both the old version.
	 */
	it("reports behind, with a count, when the upstream has moved on", () => {
		const { clone } = scaffold();
		const origin = join(dir, "origin");
		commit(origin, "b.txt", "two\n");
		commit(origin, "c.txt", "three\n");
		git(["push", "-q", "origin", "main"], origin);

		const state = describeCheckoutState(clone);
		expect(state.currency).toBe("behind");
		expect(state.behind).toBe(2);
		expect(describeCheckoutStateLine(state)).toContain("2 commit(s) BEHIND origin/main");
	});

	/**
	 * The reason the check fetches. Without the fetch, the comparison uses the
	 * remote-tracking ref the last fetch left behind, so a tree that is genuinely
	 * behind reports "current" with total confidence — the same
	 * reads-as-working-while-doing-nothing failure in a new place. This test is
	 * what stops anyone quietly making --no-fetch the default.
	 */
	it("without the fetch, a genuinely behind checkout reads as current", () => {
		const { clone } = scaffold();
		const origin = join(dir, "origin");
		commit(origin, "b.txt", "two\n");
		git(["push", "-q", "origin", "main"], origin);

		expect(describeCheckoutState(clone, { noFetch: true }).currency).toBe("current");
		expect(describeCheckoutState(clone).currency).toBe("behind");
	});

	it("reports unknown, not behind, when the branch tracks nothing", () => {
		const solo = join(dir, "solo");
		mkdirSync(solo, { recursive: true });
		git(["init", "-q", "-b", "main", "."], solo);

		// Belt and braces: prove the fixture really is its own repository before
		// writing a single object into it (#1056, #1064).
		const soloToplevel = realpathSync(git(["rev-parse", "--show-toplevel"], solo));
		expect(soloToplevel).toBe(realpathSync(solo));

		commit(solo, "a.txt", "one\n");

		const state = describeCheckoutState(solo);
		expect(state.currency).toBe("unknown");
		expect(state.upstream).toBeNull();
		expect(state.reason).toContain("tracks no upstream");
	});

	it("reports unknown for a directory that is not a git repository", () => {
		const plain = join(dir, "plain");
		mkdirSync(plain, { recursive: true });

		const state = describeCheckoutState(plain);
		expect(state.currency).toBe("unknown");
		expect(state.reason).toBe("not a git repository");
	});

	/**
	 * A tree AHEAD of its upstream is current for this purpose: it contains
	 * everything the upstream has. Treating "not identical" as stale would refuse
	 * the ordinary case of pushing skills from the branch that just changed them.
	 */
	it("treats a checkout that is ahead as current", () => {
		const { clone } = scaffold();
		commit(clone, "local.txt", "mine\n");
		expect(describeCheckoutState(clone).currency).toBe("current");
	});
});

describe("describeCheckoutState - when git cannot answer", () => {
	it("degrades to unknown rather than throwing when the fetch fails", () => {
		const state = describeCheckoutState("/anywhere", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse") return "origin/dev";
				if (args[0] === "fetch") return null; // offline
				return "0";
			},
		});
		expect(state.currency).toBe("unknown");
		expect(state.upstream).toBe("origin/dev");
		expect(state.reason).toContain("could not fetch origin/dev");
	});

	it("degrades to unknown when the count comes back unparseable", () => {
		const state = describeCheckoutState("/anywhere", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse") return "origin/dev";
				if (args[0] === "fetch") return "";
				return "not-a-number";
			},
		});
		expect(state.currency).toBe("unknown");
		expect(state.reason).toContain("could not count commits behind");
	});

	it("fetches only the tracked branch, never every ref", () => {
		const calls: string[][] = [];
		describeCheckoutState("/anywhere", {
			runGit: (args) => {
				calls.push(args);
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse") return "origin/dev";
				return args[0] === "fetch" ? "" : "0";
			},
		});
		expect(calls.find((c) => c[0] === "fetch")).toEqual(["fetch", "--quiet", "origin", "dev"]);
	});

	it("does not fetch at all when noFetch is set", () => {
		const calls: string[][] = [];
		describeCheckoutState("/anywhere", {
			noFetch: true,
			runGit: (args) => {
				calls.push(args);
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse") return "origin/dev";
				return "0";
			},
		});
		expect(calls.some((c) => c[0] === "fetch")).toBe(false);
	});
});

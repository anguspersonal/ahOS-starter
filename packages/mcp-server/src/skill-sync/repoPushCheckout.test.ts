import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashBody } from "./hash.js";
import type { CheckoutState } from "./checkoutState.js";

/**
 * The currency gate in front of `repo push` (#724).
 *
 * Kept separate from repoPush.test.ts, which declares a current checkout so its
 * assertions are about orchestration. Everything here is about the gate itself:
 * what it refuses, what it merely warns about, and — the part that matters most
 * — that a refusal writes NOTHING. A gate that blocks the report but still
 * registers the body would be worse than no gate, because the operator would
 * believe nothing happened.
 */
const upsertSkillCapability = vi.fn();
class SkillKindConflictError extends Error {}
vi.mock("./ahkmsSource.js", () => ({
	upsertSkillCapability: (...args: unknown[]) => upsertSkillCapability(...args),
	SkillKindConflictError,
}));

const { pushRepoSkills, formatRepoPush } = await import("./repoPush.js");

const BODY = "---\nname: dos-hl\ndescription: the ritual\n---\n\nDraft and stop.\n";
const NOW = () => new Date("2026-08-21T12:00:00.000Z");

const BEHIND: CheckoutState = { currency: "behind", behind: 4, upstream: "origin/main" };
const CURRENT: CheckoutState = { currency: "current", behind: 0, upstream: "origin/main" };
const UNKNOWN: CheckoutState = {
	currency: "unknown",
	behind: 0,
	upstream: null,
	reason: "this branch tracks no upstream, so there is nothing to compare against",
};

let repoRoot: string;
let skillsHome: string;

beforeEach(() => {
	repoRoot = mkdtempSync(join(tmpdir(), "repo-push-checkout-"));
	skillsHome = mkdtempSync(join(tmpdir(), "repo-push-checkout-home-"));
	const dir = join(repoRoot, ".claude", "skills", "dos-hl");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), BODY, "utf8");
	writeFileSync(
		join(repoRoot, ".claude", "skill-registry.json"),
		JSON.stringify(
			{
				version: 1,
				skills: {
					"dos-hl": {
						register: true,
						why: "portable ritual",
						surface: ["claude-code"],
						supporting_files: [],
						body_sha256: hashBody(BODY),
						registered_at: null,
					},
				},
			},
			null,
			"\t",
		) + "\n",
		"utf8",
	);
	upsertSkillCapability.mockReset();
	upsertSkillCapability.mockResolvedValue("updated");
});
afterEach(() => {
	rmSync(repoRoot, { recursive: true, force: true });
	rmSync(skillsHome, { recursive: true, force: true });
});

const run = (state: CheckoutState, extra: Record<string, unknown> = {}) =>
	pushRepoSkills(undefined, { repoRoot, skillsHome, now: NOW, checkoutState: () => state, ...extra });

function manifestOnDisk() {
	return JSON.parse(readFileSync(join(repoRoot, ".claude", "skill-registry.json"), "utf8"));
}

describe("repo push - the currency gate", () => {
	it("refuses when the checkout is behind its upstream", async () => {
		const results = await run(BEHIND);
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("refused");
		expect(results[0].reason).toContain("4 commit(s) BEHIND origin/main");
	});

	/**
	 * The load-bearing one. #724's damage was a body reaching production from a
	 * stale tree; a refusal that still called ahkms would reproduce it exactly.
	 */
	it("registers nothing and stamps nothing when it refuses", async () => {
		await run(BEHIND);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
		expect(manifestOnDisk().skills["dos-hl"].registered_at).toBeNull();
	});

	it("pushes normally when the checkout is current", async () => {
		const results = await run(CURRENT);
		expect(results).toEqual([{ name: "dos-hl", outcome: "updated" }]);
		expect(upsertSkillCapability).toHaveBeenCalledTimes(1);
	});

	it("pushes when behind but --allow-behind was passed", async () => {
		const results = await run(BEHIND, { allowBehind: true });
		expect(results).toEqual([{ name: "dos-hl", outcome: "updated" }]);
		expect(upsertSkillCapability).toHaveBeenCalledTimes(1);
	});

	/**
	 * A dry run touches neither ahkms nor the manifest, so a stale tree has
	 * nothing to corrupt — and blocking it would deny the operator the preview
	 * that shows what the stale push WOULD have done.
	 */
	it("does not gate a dry run", async () => {
		const results = await pushRepoSkills(undefined, {
			repoRoot,
			skillsHome,
			now: NOW,
			dryRun: true,
			checkoutState: () => {
				throw new Error("the gate must not run for a dry run");
			},
		});
		expect(results.map((result) => result.outcome)).toEqual(["would-push"]);
		expect(upsertSkillCapability).not.toHaveBeenCalled();
	});
});

describe("repo push - unknown currency", () => {
	it("warns and still pushes, because a no-upstream checkout is legitimate", async () => {
		const results = await run(UNKNOWN);
		expect(results.find((result) => result.outcome === "warned")?.reason).toContain("UNKNOWN");
		expect(results.find((result) => result.name === "dos-hl")?.outcome).toBe("updated");
		expect(upsertSkillCapability).toHaveBeenCalledTimes(1);
	});

	/**
	 * `warned` must not read as a failure. The CLI exits non-zero on `skipped`
	 * and `refused`; if the warning used either, every push from a checkout with
	 * no upstream would exit 1 and the warning would be turned off within a week.
	 */
	it("does not report the warning as a skipped skill", async () => {
		const results = await run(UNKNOWN);
		expect(results.some((result) => result.outcome === "skipped")).toBe(false);
	});

	it("does not count the checkout note as a processed skill", async () => {
		const text = formatRepoPush(await run(UNKNOWN), "/tmp/manifest.json");
		expect(text).toContain("1 repo skill(s) processed.");
	});

	it("prints the refusal above everything else", async () => {
		const text = formatRepoPush(await run(BEHIND), "/tmp/manifest.json");
		expect(text.startsWith("refused (1):")).toBe(true);
	});
});

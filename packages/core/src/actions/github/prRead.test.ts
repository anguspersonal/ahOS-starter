import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { createOctokitGithubReadAdapter } from "../../adapters/github/reads.js";
import type { GithubPullRequestRead, GithubReadPort } from "../../ports/github.js";
import {
	createGithubPrDiffAction,
	createGithubPrGetAction,
	createGithubPrMergeabilityAction,
} from "./prRead.js";

function makePrFixture(overrides?: Partial<GithubPullRequestRead>): GithubPullRequestRead {
	return {
		number: 7,
		title: "feat: add pr reads",
		state: "open",
		draft: false,
		merged: false,
		head: { ref: "feat/pr-reads", sha: "aaa111" },
		base: { ref: "dev", sha: "bbb222" },
		author: "anguspersonal",
		html_url: "https://github.com/anguspersonal/ahOS/pull/7",
		additions: 120,
		deletions: 10,
		changed_files: 4,
		created_at: "2026-10-16T10:00:00Z",
		updated_at: "2026-10-16T11:00:00Z",
		body: "Short body",
		mergeable: true,
		mergeable_state: "clean",
		...overrides,
	};
}

describe("GitHub PR read actions", () => {
	it("case 1: rejects when repo is on no list (naming read_repos, issue_repos, pr_repos) without calling port, and admits anguspersonal/ahOS via anguspersonal/* on read_repos", async () => {
		const port: GithubReadPort = {
			getPull: vi.fn(async () => makePrFixture()),
			getPullDiff: vi.fn(async () => ""),
		};

		const deniedDb = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: { read_repos: ["other/repo"], issue_repos: [], pr_repos: [] },
			},
			error: null,
		}));

		const deniedAction = createGithubPrGetAction({
			port,
			supabase: deniedDb.client,
			getUserId: () => "u-1",
		});

		await expect(
			deniedAction.run({ repo: "anguspersonal/ahOS", number: 7, max_body_chars: 20_000 }, { caller: "mcp", requestId: "req-1" }),
		).rejects.toThrow(/read_repos.*issue_repos.*pr_repos/);
		expect(port.getPull).not.toHaveBeenCalled();

		const allowedDb = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: { read_repos: ["anguspersonal/*"] },
			},
			error: null,
		}));

		const allowedAction = createGithubPrGetAction({
			port,
			supabase: allowedDb.client,
			getUserId: () => "u-1",
		});

		const res = await allowedAction.run(
			{ repo: "anguspersonal/ahOS", number: 7, max_body_chars: 20_000 },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(res.number).toBe(7);
		expect(port.getPull).toHaveBeenCalledWith("anguspersonal/ahOS", 7);
	});

	it("case 2: github_pr_get maps fields and truncates a 25,000-character body to 20,000 with body_truncated: true and body_chars: 25000", async () => {
		const longBody = "x".repeat(25_000);
		const port: GithubReadPort = {
			getPull: vi.fn(async () => makePrFixture({ body: longBody })),
			getPullDiff: vi.fn(async () => ""),
		};
		const db = createFakeSupabase(() => ({
			data: { enabled: true, config: { read_repos: ["anguspersonal/*"] } },
			error: null,
		}));

		const action = createGithubPrGetAction({
			port,
			supabase: db.client,
			getUserId: () => "u-1",
		});

		const res = await action.run(
			{ repo: "anguspersonal/ahOS", number: 7, max_body_chars: 20_000 },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(res.body).toHaveLength(20_000);
		expect(res.body_truncated).toBe(true);
		expect(res.body_chars).toBe(25_000);
		expect(res.head).toEqual({ ref: "feat/pr-reads", sha: "aaa111" });
		expect(res.base).toEqual({ ref: "dev", sha: "bbb222" });
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 3: github_pr_diff with max_chars: 1000 over a 5,000-character diff returns 1,000 characters, truncated: true, total_chars: 5000", async () => {
		const port: GithubReadPort = {
			getPull: vi.fn(async () => makePrFixture()),
			getPullDiff: vi.fn(async () => "d".repeat(5_000)),
		};
		const db = createFakeSupabase(() => ({
			data: { enabled: true, config: { pr_repos: ["anguspersonal/ahOS"] } },
			error: null,
		}));

		const action = createGithubPrDiffAction({
			port,
			supabase: db.client,
			getUserId: () => "u-1",
		});

		const res = await action.run(
			{ repo: "anguspersonal/ahOS", number: 7, max_chars: 1000 },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(res.diff).toHaveLength(1000);
		expect(res.truncated).toBe(true);
		expect(res.total_chars).toBe(5000);
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 4: github_pr_mergeability re-reads once when mergeable is null, reporting computed: false and mergeable: null; passes false with dirty through", async () => {
		const getPullNull = vi.fn(async () => makePrFixture({ mergeable: null, mergeable_state: "unknown" }));
		const db = createFakeSupabase(() => ({
			data: { enabled: true, config: { read_repos: ["anguspersonal/*"] } },
			error: null,
		}));

		const nullAction = createGithubPrMergeabilityAction({
			port: { getPull: getPullNull, getPullDiff: vi.fn() },
			supabase: db.client,
			getUserId: () => "u-1",
			sleep: async () => {},
		});

		const nullRes = await nullAction.run({ repo: "anguspersonal/ahOS", number: 7 }, { caller: "mcp", requestId: "req-1" });
		expect(getPullNull).toHaveBeenCalledTimes(2);
		expect(nullRes).toEqual({
			mergeable: null,
			mergeable_state: "unknown",
			head_ref: "feat/pr-reads",
			base_ref: "dev",
			computed: false,
		});
		{
			const parsed = nullAction.outputSchema.safeParse(nullRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		const getPullDirty = vi.fn(async () => makePrFixture({ mergeable: false, mergeable_state: "dirty" }));
		const dirtyAction = createGithubPrMergeabilityAction({
			port: { getPull: getPullDirty, getPullDiff: vi.fn() },
			supabase: db.client,
			getUserId: () => "u-1",
			sleep: async () => {},
		});

		const dirtyRes = await dirtyAction.run({ repo: "anguspersonal/ahOS", number: 7 }, { caller: "mcp", requestId: "req-1" });
		expect(getPullDirty).toHaveBeenCalledTimes(1);
		expect(dirtyRes).toEqual({
			mergeable: false,
			mergeable_state: "dirty",
			head_ref: "feat/pr-reads",
			base_ref: "dev",
			computed: true,
		});
		{
			const parsed = dirtyAction.outputSchema.safeParse(dirtyRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 5: token resolver returning null rejects naming GITHUB_TOKEN_INGEST with no network request", async () => {
		const fetchSpy = vi.fn();
		const port = createOctokitGithubReadAdapter(() => null, { fetch: fetchSpy as any });
		const db = createFakeSupabase(() => ({
			data: { enabled: true, config: { read_repos: ["anguspersonal/*"] } },
			error: null,
		}));

		const action = createGithubPrGetAction({
			port,
			supabase: db.client,
			getUserId: () => "u-1",
		});

		await expect(
			action.run({ repo: "anguspersonal/ahOS", number: 7, max_body_chars: 20_000 }, { caller: "mcp", requestId: "req-1" }),
		).rejects.toThrow(/GITHUB_TOKEN_INGEST/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("case 6: port throwing a 404 surfaces 'not found, or not visible to the read token: owner/name#7'", async () => {
		const err404 = Object.assign(new Error("Not Found"), { status: 404 });
		const port: GithubReadPort = {
			getPull: vi.fn(async () => {
				throw err404;
			}),
			getPullDiff: vi.fn(async () => {
				throw err404;
			}),
		};
		const db = createFakeSupabase(() => ({
			data: { enabled: true, config: { read_repos: ["owner/name"] } },
			error: null,
		}));

		const action = createGithubPrGetAction({
			port,
			supabase: db.client,
			getUserId: () => "u-1",
		});

		await expect(
			action.run({ repo: "owner/name", number: 7, max_body_chars: 20_000 }, { caller: "mcp", requestId: "req-1" }),
		).rejects.toThrow("not found, or not visible to the read token: owner/name#7");
	});
});

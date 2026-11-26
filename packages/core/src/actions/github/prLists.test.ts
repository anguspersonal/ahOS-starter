import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import type { GithubPullFileItem, GithubReadPort } from "../../ports/github.js";
import {
	createGithubPrCommitListAction,
	createGithubPrFileListAction,
	createGithubPrListAction,
	createGithubPrReviewListAction,
} from "./prLists.js";

function makeAllowedDb() {
	return createFakeSupabase(() => ({
		data: { enabled: true, config: { read_repos: ["anguspersonal/*"] } },
		error: null,
	}));
}

describe("GitHub PR list actions", () => {
	it("case 1: a page with a next link returns next_cursor: '2'; passing it back requests page 2; the last page returns next_cursor: null", async () => {
		const listPulls = vi.fn(async (_repo: string, params: { page: number; limit: number }) => {
			if (params.page === 1) {
				return {
					items: [
						{
							number: 101,
							title: "feat: first page",
							state: "open",
							draft: false,
							head_ref: "feat/1",
							base_ref: "dev",
							author: "anguspersonal",
							updated_at: "2026-10-19T10:00:00Z",
							html_url: "https://github.com/anguspersonal/ahOS/pull/101",
						},
					],
					next_cursor: "2",
				};
			}
			return {
				items: [
					{
						number: 102,
						title: "feat: second page",
						state: "open",
						draft: false,
						head_ref: "feat/2",
						base_ref: "dev",
						author: "anguspersonal",
						updated_at: "2026-10-19T11:00:00Z",
						html_url: "https://github.com/anguspersonal/ahOS/pull/102",
					},
				],
				next_cursor: null,
			};
		});

		const port: GithubReadPort = {
			getPull: vi.fn(),
			getPullDiff: vi.fn(),
			listPulls,
		};
		const db = makeAllowedDb();
		const action = createGithubPrListAction({ port, supabase: db.client, getUserId: () => "u-1" });

		const page1 = await action.run(
			{ repo: "anguspersonal/ahOS", state: "open", limit: 30 },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(page1.next_cursor).toBe("2");
		expect(page1.items).toHaveLength(1);
		expect(listPulls).toHaveBeenCalledWith("anguspersonal/ahOS", {
			state: "open",
			head: undefined,
			base: undefined,
			limit: 30,
			page: 1,
		});

		const page2 = await action.run(
			{ repo: "anguspersonal/ahOS", state: "open", limit: 30, cursor: page1.next_cursor! },
			{ caller: "mcp", requestId: "req-2" },
		);
		expect(page2.next_cursor).toBeNull();
		expect(page2.items[0]?.number).toBe(102);
		{
			const parsed1 = action.outputSchema.safeParse(page1);
			expect(parsed1.success, parsed1.success ? undefined : JSON.stringify(parsed1.error.issues)).toBe(true);
			const parsed2 = action.outputSchema.safeParse(page2);
			expect(parsed2.success, parsed2.success ? undefined : JSON.stringify(parsed2.error.issues)).toBe(true);
		}
		expect(listPulls).toHaveBeenCalledWith("anguspersonal/ahOS", {
			state: "open",
			head: undefined,
			base: undefined,
			limit: 30,
			page: 2,
		});
	});

	it("case 2: github_pr_file_list at 3,000 files returns truncated: true; at 120 files, false", async () => {
		const makeFile = (idx: number): GithubPullFileItem => ({
			filename: `src/file-${idx}.ts`,
			status: "modified",
			additions: 1,
			deletions: 0,
			changes: 1,
			previous_filename: null,
		});

		const db = makeAllowedDb();

		const port3000: GithubReadPort = {
			getPull: vi.fn(),
			getPullDiff: vi.fn(),
			listPullFiles: vi.fn(async () => ({
				items: Array.from({ length: 3000 }, (_, i) => makeFile(i)),
				next_cursor: null,
			})),
		};
		const action3000 = createGithubPrFileListAction({ port: port3000, supabase: db.client, getUserId: () => "u-1" });
		const res3000 = await action3000.run(
			{ repo: "anguspersonal/ahOS", number: 7, include_patch: false, limit: 100 },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(res3000.truncated).toBe(true);
		{
			const parsed = action3000.outputSchema.safeParse(res3000);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		const portPage30: GithubReadPort = {
			getPull: vi.fn(),
			getPullDiff: vi.fn(),
			listPullFiles: vi.fn(async () => ({
				items: Array.from({ length: 100 }, (_, i) => makeFile(i)),
				next_cursor: null,
			})),
		};
		const actionPage30 = createGithubPrFileListAction({ port: portPage30, supabase: db.client, getUserId: () => "u-1" });
		const resPage30 = await actionPage30.run(
			{ repo: "anguspersonal/ahOS", number: 7, include_patch: false, limit: 100, cursor: "30" },
			{ caller: "mcp", requestId: "req-2" },
		);
		expect(resPage30.truncated).toBe(true);

		const port120: GithubReadPort = {
			getPull: vi.fn(),
			getPullDiff: vi.fn(),
			listPullFiles: vi.fn(async () => ({
				items: Array.from({ length: 120 }, (_, i) => makeFile(i)),
				next_cursor: null,
			})),
		};
		const action120 = createGithubPrFileListAction({ port: port120, supabase: db.client, getUserId: () => "u-1" });
		const res120 = await action120.run(
			{ repo: "anguspersonal/ahOS", number: 7, include_patch: false, limit: 100 },
			{ caller: "mcp", requestId: "req-3" },
		);
		expect(res120.truncated).toBe(false);
		{
			const parsed = action120.outputSchema.safeParse(res120);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 3: github_pr_commit_list at 250 commits returns truncated: true", async () => {
		const db = makeAllowedDb();
		const port250: GithubReadPort = {
			getPull: vi.fn(),
			getPullDiff: vi.fn(),
			listPullCommits: vi.fn(async () => ({
				items: Array.from({ length: 250 }, (_, i) => ({
					sha: `sha-${i}`,
					message: `feat: commit ${i}`,
					author: "anguspersonal",
					date: "2026-10-19T10:00:00Z",
				})),
				next_cursor: null,
			})),
		};

		const action = createGithubPrCommitListAction({ port: port250, supabase: db.client, getUserId: () => "u-1" });
		const res = await action.run(
			{ repo: "anguspersonal/ahOS", number: 7, limit: 100 },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(res.truncated).toBe(true);
		expect(res.items).toHaveLength(250);
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 4: include_patch: true caps a 9,000-character patch at 5,000 with patch_truncated: true; the default omits patch", async () => {
		const db = makeAllowedDb();
		const longPatch = "p".repeat(9_000);
		const port: GithubReadPort = {
			getPull: vi.fn(),
			getPullDiff: vi.fn(),
			listPullFiles: vi.fn(async () => ({
				items: [
					{
						filename: "src/index.ts",
						status: "modified",
						additions: 50,
						deletions: 10,
						changes: 60,
						previous_filename: null,
						patch: longPatch,
					},
				],
				next_cursor: null,
			})),
		};

		const action = createGithubPrFileListAction({ port, supabase: db.client, getUserId: () => "u-1" });

		const defaultRes = await action.run(
			{ repo: "anguspersonal/ahOS", number: 7, include_patch: false, limit: 30 },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(defaultRes.items[0]?.patch).toBeUndefined();
		expect(defaultRes.items[0]?.patch_truncated).toBeUndefined();
		{
			const parsed = action.outputSchema.safeParse(defaultRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		const patchRes = await action.run(
			{ repo: "anguspersonal/ahOS", number: 7, include_patch: true, limit: 30 },
			{ caller: "mcp", requestId: "req-2" },
		);
		expect(patchRes.items[0]?.patch).toHaveLength(5_000);
		expect(patchRes.items[0]?.patch_truncated).toBe(true);
		{
			const parsed = action.outputSchema.safeParse(patchRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 5: a review body of 3,000 characters is cut to 2,000 with body_truncated: true", async () => {
		const db = makeAllowedDb();
		const longReviewBody = "r".repeat(3_000);
		const port: GithubReadPort = {
			getPull: vi.fn(),
			getPullDiff: vi.fn(),
			listPullReviews: vi.fn(async () => ({
				items: [
					{
						id: 501,
						user: "reviewer1",
						state: "COMMENTED",
						submitted_at: "2026-10-19T10:00:00Z",
						body: longReviewBody,
					},
				],
				next_cursor: null,
			})),
		};

		const action = createGithubPrReviewListAction({ port, supabase: db.client, getUserId: () => "u-1" });
		const res = await action.run(
			{ repo: "anguspersonal/ahOS", number: 7, limit: 30 },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(res.items[0]?.body).toHaveLength(2_000);
		expect(res.items[0]?.body_truncated).toBe(true);
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 6: a repo outside the allowlist rejects before the port is called", async () => {
		const deniedDb = createFakeSupabase(() => ({
			data: { enabled: true, config: { read_repos: ["anguspersonal/*"], issue_repos: [], pr_repos: [] } },
			error: null,
		}));
		const port: GithubReadPort = {
			getPull: vi.fn(),
			getPullDiff: vi.fn(),
			listPulls: vi.fn(),
			listPullFiles: vi.fn(),
			listPullCommits: vi.fn(),
			listPullReviews: vi.fn(),
		};

		const listAction = createGithubPrListAction({ port, supabase: deniedDb.client, getUserId: () => "u-1" });
		await expect(
			listAction.run({ repo: "other/repo", state: "open", limit: 30 }, { caller: "mcp", requestId: "req-1" }),
		).rejects.toThrow(/read_repos.*issue_repos.*pr_repos/);
		expect(port.listPulls).not.toHaveBeenCalled();
	});
});

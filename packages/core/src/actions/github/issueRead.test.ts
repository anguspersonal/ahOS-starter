import { describe, expect, it, vi } from "vitest";
import type { GithubReadPort } from "../../ports/github.js";
import type { ActionContext } from "../types.js";
import type { GenericSupabaseClient } from "./issueCreate.js";
import {
	createGithubIssueCommentListAction,
	createGithubIssueGetAction,
	createGithubIssueSearchAction,
	createGithubIssueTimelineAction,
} from "./issueRead.js";

function createFakeSupabase(options?: {
	enabled?: boolean;
	read_repos?: string[];
	issue_repos?: string[];
	pr_repos?: string[];
}): GenericSupabaseClient {
	const enabled = options?.enabled ?? true;
	const config = {
		read_repos: options?.read_repos ?? ["anguspersonal/*"],
		issue_repos: options?.issue_repos ?? ["anguspersonal/ahOS"],
		pr_repos: options?.pr_repos ?? ["anguspersonal/ahOS"],
	};

	return {
		from() {
			return {
				select() {
					return {
						eq() {
							return {
								eq() {
									return {
										async maybeSingle() {
											return {
												data: { enabled, config },
												error: null,
											};
										},
									};
								},
							};
						},
					};
				},
			};
		},
	};
}

function createFakePort(overrides?: Partial<GithubReadPort>): GithubReadPort {
	return {
		getPull: vi.fn(),
		getPullDiff: vi.fn(),
		getIssue: vi.fn(async (_repo, number) => ({
			number,
			title: "feat: issue reads",
			state: "open",
			state_reason: null,
			labels: ["status:agent-ready"],
			assignees: ["anguspersonal"],
			author: "anguspersonal",
			is_pull_request: false,
			comments: 2,
			created_at: "2026-10-19T00:00:00Z",
			updated_at: "2026-10-19T01:00:00Z",
			closed_at: null,
			html_url: `https://github.com/anguspersonal/ahOS/issues/${number}`,
			body: "Issue description",
		})),
		listIssueComments: vi.fn(async () => ({
			items: [],
			next_cursor: null,
		})),
		listIssueTimeline: vi.fn(async () => ({
			items: [],
			next_cursor: null,
		})),
		searchIssues: vi.fn(async () => ({
			items: [],
			total_count: 0,
			incomplete_results: false,
			next_cursor: null,
		})),
		...overrides,
	};
}

describe("github issue read actions", () => {
	const context: ActionContext = {
		userId: "user-123",
		caller: "mcp",
		requestId: "req-123",
	};

	it("1. github_issue_get on a 404 rejects with the not-found message; it never resolves null", async () => {
		const port = createFakePort({
			getIssue: vi.fn(async () => {
				const err = new Error("Not Found") as Error & { status?: number };
				err.status = 404;
				throw err;
			}),
		});
		const action = createGithubIssueGetAction({
			port,
			supabase: createFakeSupabase(),
		});

		await expect(
			action.run({ repo: "anguspersonal/ahOS", number: 9999 }, context),
		).rejects.toThrow("not found, or not visible to the read token: anguspersonal/ahOS#9999");
	});

	it("2. github_issue_search over five hits, two in a repo outside the allowlist: three items, dropped: 2, and the excluded repo's name appears nowhere in the result", async () => {
		const excludedRepo = "secret-corp/confidential-repo";
		const port = createFakePort({
			searchIssues: vi.fn(async () => ({
				items: [
					{
						repo: "anguspersonal/ahOS",
						number: 101,
						title: "Allowed 1",
						state: "open",
						is_pull_request: false,
						updated_at: "2026-10-19T00:00:00Z",
						html_url: "https://github.com/anguspersonal/ahOS/issues/101",
					},
					{
						repo: excludedRepo,
						number: 202,
						title: "Excluded 1",
						state: "open",
						is_pull_request: false,
						updated_at: "2026-10-19T00:00:00Z",
						html_url: `https://github.com/${excludedRepo}/issues/202`,
					},
					{
						repo: "anguspersonal/other-repo",
						number: 102,
						title: "Allowed 2",
						state: "closed",
						is_pull_request: false,
						updated_at: "2026-10-19T00:00:00Z",
						html_url: "https://github.com/anguspersonal/other-repo/issues/102",
					},
					{
						repo: excludedRepo,
						number: 203,
						title: "Excluded 2",
						state: "open",
						is_pull_request: true,
						updated_at: "2026-10-19T00:00:00Z",
						html_url: `https://github.com/${excludedRepo}/pull/203`,
					},
					{
						repo: "anguspersonal/ahOS",
						number: 103,
						title: "Allowed 3",
						state: "open",
						is_pull_request: true,
						updated_at: "2026-10-19T00:00:00Z",
						html_url: "https://github.com/anguspersonal/ahOS/pull/103",
					},
				],
				total_count: 5,
				incomplete_results: false,
				next_cursor: null,
			})),
		});

		const action = createGithubIssueSearchAction({
			port,
			supabase: createFakeSupabase({ read_repos: ["anguspersonal/*"], issue_repos: [], pr_repos: [] }),
		});

		const res = await action.run({ query: "is:open", limit: 30 }, context);
		expect(res.items).toHaveLength(3);
		expect(res.dropped).toBe(2);
		expect(JSON.stringify(res)).not.toContain(excludedRepo);
		expect(JSON.stringify(res)).not.toContain("secret-corp");
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("3. incomplete_results: true from GitHub is passed through", async () => {
		const port = createFakePort({
			searchIssues: vi.fn(async () => ({
				items: [
					{
						repo: "anguspersonal/ahOS",
						number: 1,
						title: "First",
						state: "open",
						is_pull_request: false,
						updated_at: "2026-10-19T00:00:00Z",
						html_url: "https://github.com/anguspersonal/ahOS/issues/1",
					},
				],
				total_count: 1,
				incomplete_results: true,
				next_cursor: "2",
			})),
		});

		const action = createGithubIssueSearchAction({
			port,
			supabase: createFakeSupabase(),
		});

		const res = await action.run({ query: "timeout", limit: 30 }, context);
		expect(res.incomplete_results).toBe(true);
		expect(res.next_cursor).toBe("2");
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("4. Comment bodies over 4,000 characters are cut with body_truncated: true; next_cursor follows the Link header", async () => {
		const longComment = "c".repeat(5_200);
		const port = createFakePort({
			listIssueComments: vi.fn(async () => ({
				items: [
					{
						id: 901,
						author: "anguspersonal",
						created_at: "2026-10-19T00:00:00Z",
						updated_at: "2026-10-19T01:00:00Z",
						body: longComment,
						html_url: "https://github.com/anguspersonal/ahOS/issues/10#issuecomment-901",
					},
					{
						id: 902,
						author: "reviewer",
						created_at: "2026-10-19T02:00:00Z",
						updated_at: "2026-10-19T02:00:00Z",
						body: "short comment",
						html_url: "https://github.com/anguspersonal/ahOS/issues/10#issuecomment-902",
					},
				],
				next_cursor: "3",
			})),
		});

		const action = createGithubIssueCommentListAction({
			port,
			supabase: createFakeSupabase(),
		});

		const res = await action.run({ repo: "anguspersonal/ahOS", number: 10, limit: 30, cursor: "2" }, context);
		expect(res.next_cursor).toBe("3");
		expect(res.items[0]?.body?.length).toBe(4_000);
		expect(res.items[0]?.body_truncated).toBe(true);
		expect(res.items[1]?.body).toBe("short comment");
		expect(res.items[1]?.body_truncated).toBeUndefined();
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("5. Timeline items carry ids and no body text", async () => {
		const port = createFakePort({
			listIssueTimeline: vi.fn(async () => ({
				items: [
					{
						event: "labeled",
						actor: "anguspersonal",
						created_at: "2026-10-19T00:00:00Z",
						label: "status:agent-ready",
						body: "should be stripped",
					} as any,
					{
						event: "cross-referenced",
						actor: "anguspersonal",
						created_at: "2026-10-19T01:00:00Z",
						source_issue_number: 1640,
					},
					{
						event: "closed",
						actor: "anguspersonal",
						created_at: "2026-10-19T02:00:00Z",
						commit_id: "abc1234",
						closing_pr_number: 1900,
					},
				],
				next_cursor: null,
			})),
		});

		const action = createGithubIssueTimelineAction({
			port,
			supabase: createFakeSupabase(),
		});

		const res = await action.run({ repo: "anguspersonal/ahOS", number: 10, limit: 30 }, context);
		expect(res.items).toEqual([
			{
				event: "labeled",
				actor: "anguspersonal",
				created_at: "2026-10-19T00:00:00Z",
				label: "status:agent-ready",
			},
			{
				event: "cross-referenced",
				actor: "anguspersonal",
				created_at: "2026-10-19T01:00:00Z",
				source_issue_number: 1640,
			},
			{
				event: "closed",
				actor: "anguspersonal",
				created_at: "2026-10-19T02:00:00Z",
				commit_id: "abc1234",
				closing_pr_number: 1900,
			},
		]);
		expect(JSON.stringify(res)).not.toContain("should be stripped");
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("6. github_issue_get happy path returns issue matching outputSchema", async () => {
		const port = createFakePort();
		const action = createGithubIssueGetAction({
			port,
			supabase: createFakeSupabase(),
		});

		const res = await action.run({ repo: "anguspersonal/ahOS", number: 42 }, context);
		expect(res.number).toBe(42);
		expect(res.title).toBe("feat: issue reads");
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});
});

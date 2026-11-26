import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { createOctokitGithubReadAdapter } from "../../adapters/github/reads.js";
import type { GithubReadPort } from "../../ports/github.js";
import type { GenericSupabaseClient } from "./issueCreate.js";
import {
	createGithubRunListAction,
	createGithubRunJobListAction,
	createGithubJobLogGetAction,
} from "./runRead.js";

function makeFakeSupabase(config: Record<string, unknown> | null = { issue_repos: ["anguspersonal/ahOS"] }) {
	return {
		from(_table: string) {
			return {
				select(_cols: string) {
					return {
						eq(_col1: string, _val1: string) {
							return {
								eq(_col2: string, _val2: string) {
									return {
										async maybeSingle() {
											if (!config) {
												return { data: null, error: null };
											}
											return {
												data: { enabled: true, config },
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
	} as unknown as GenericSupabaseClient;
}

describe("github_run_list, github_run_job_list, and github_job_log_get actions (#1644)", () => {
	it("case 1: a 50,000-character log with the default returns its last 20,000 characters, truncated: true, total_chars: 50000", async () => {
		const prefix = "A".repeat(30_000);
		const suffix = "B".repeat(20_000);
		const fullLog = prefix + suffix;

		const fakeFetch: typeof globalThis.fetch = vi.fn(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/actions/jobs/777/logs")) {
				return new Response(null, {
					status: 302,
					headers: {
						location: "https://results-receiver.actions.githubusercontent.com/signed-blob-50k",
					},
				});
			}
			return new Response(fullLog, {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});

		const port = createOctokitGithubReadAdapter(() => "ghp_read_token_secret", {
			fetch: fakeFetch,
		});

		const action = createGithubJobLogGetAction({
			port,
			supabase: makeFakeSupabase(),
			getUserId: () => "user-1",
		});

		const res = await executeAction(action, {
			repo: "anguspersonal/ahOS",
			job_id: 777,
		});

		expect(res.truncated).toBe(true);
		expect(res.total_chars).toBe(50_000);
		expect(res.log?.length).toBe(20_000);
		expect(res.log).toBe(suffix);
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 2: a 410 resolves { expired: true }", async () => {
		const fakeFetch: typeof globalThis.fetch = vi.fn(async () => {
			return new Response(null, { status: 410 });
		});

		const port = createOctokitGithubReadAdapter(() => "ghp_read_token_secret", {
			fetch: fakeFetch,
		});

		const action = createGithubJobLogGetAction({
			port,
			supabase: makeFakeSupabase(),
			getUserId: () => "user-1",
		});

		const res = await executeAction(action, {
			repo: "anguspersonal/ahOS",
			job_id: 410,
		});

		expect(res).toEqual({ expired: true });
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 3: signed log fetch carries no Authorization header on the second request", async () => {
		const seenCalls: Array<{ url: string; headers: Record<string, string> }> = [];
		const fakeFetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers: Record<string, string> = {};
			if (init?.headers) {
				const h = new Headers(init.headers as HeadersInit);
				h.forEach((v, k) => {
					headers[k.toLowerCase()] = v;
				});
			}
			seenCalls.push({ url, headers });

			if (url.endsWith("/actions/jobs/555/logs")) {
				return new Response(null, {
					status: 302,
					headers: {
						location: "https://results-receiver.actions.githubusercontent.com/signed-blob?sig=xyz",
					},
				});
			}
			return new Response("final failure line\n", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});

		const port = createOctokitGithubReadAdapter(() => "ghp_read_token_secret", {
			fetch: fakeFetch,
		});

		const action = createGithubJobLogGetAction({
			port,
			supabase: makeFakeSupabase(),
			getUserId: () => "user-1",
		});

		const res = await executeAction(action, {
			repo: "anguspersonal/ahOS",
			job_id: 555,
		});

		expect(res.log).toBe("final failure line\n");
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
		expect(seenCalls).toHaveLength(2);
		expect(seenCalls[0]?.headers.authorization).toBe("token ghp_read_token_secret");
		expect(seenCalls[1]?.url).toContain("results-receiver.actions.githubusercontent.com");
		expect(seenCalls[1]?.headers.authorization).toBeUndefined();
	});

	it("case 4: github_run_list with neither head_sha nor branch fails validation", async () => {
		const port: GithubReadPort = {
			getPull: async () => {
				throw new Error("not used");
			},
			getPullDiff: async () => "",
			listWorkflowRuns: vi.fn(),
		};

		const action = createGithubRunListAction({
			port,
			supabase: makeFakeSupabase(),
			getUserId: () => "user-1",
		});

		await expect(
			executeAction(action, {
				repo: "anguspersonal/ahOS",
			}),
		).rejects.toThrowError(/head_sha or branch/i);

		expect(port.listWorkflowRuns).not.toHaveBeenCalled();
	});

	it("case 5: a 403 whose body says Resource not accessible by personal access token names actions:read and GITHUB_TOKEN_INGEST", async () => {
		const fakeFetch: typeof globalThis.fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({ message: "Resource not accessible by personal access token" }),
				{
					status: 403,
					headers: { "content-type": "application/json" },
				},
			);
		});

		const port = createOctokitGithubReadAdapter(() => "ghp_read_token_secret", {
			fetch: fakeFetch,
		});

		const runListAction = createGithubRunListAction({
			port,
			supabase: makeFakeSupabase(),
			getUserId: () => "user-1",
		});

		await expect(
			executeAction(runListAction, {
				repo: "anguspersonal/ahOS",
				branch: "dev",
			}),
		).rejects.toSatisfy((err: unknown) => {
			const e = err as Error;
			expect(e.message).toContain("actions:read");
			expect(e.message).toContain("GITHUB_TOKEN_INGEST");
			return true;
		});

		const jobListAction = createGithubRunJobListAction({
			port,
			supabase: makeFakeSupabase(),
			getUserId: () => "user-1",
		});

		await expect(
			executeAction(jobListAction, {
				repo: "anguspersonal/ahOS",
				run_id: 123,
			}),
		).rejects.toSatisfy((err: unknown) => {
			const e = err as Error;
			expect(e.message).toContain("actions:read");
			expect(e.message).toContain("GITHUB_TOKEN_INGEST");
			return true;
		});
	});

	it("case 6: github_run_list and github_run_job_list happy paths match their outputSchemas", async () => {
		const port: GithubReadPort = {
			getPull: async () => {
				throw new Error("not used");
			},
			getPullDiff: async () => "",
			listWorkflowRuns: vi.fn(async () => ({
				items: [
					{
						id: 1001,
						name: "CI",
						event: "pull_request",
						status: "completed",
						conclusion: "success",
						head_sha: "abc1234",
						head_branch: "feat/test",
						run_attempt: 1,
						created_at: "2026-10-19T10:00:00Z",
						html_url: "https://github.com/anguspersonal/ahOS/actions/runs/1001",
					},
				],
				next_cursor: null,
				total_count: 1,
			})),
			listWorkflowRunJobs: vi.fn(async () => ({
				items: [
					{
						id: 2001,
						name: "test",
						status: "completed",
						conclusion: "success",
						started_at: "2026-10-19T10:00:10Z",
						completed_at: "2026-10-19T10:01:00Z",
						steps: [
							{
								name: "Run tests",
								number: 1,
								conclusion: "success",
							},
						],
					},
				],
				next_cursor: null,
			})),
		};

		const runListAction = createGithubRunListAction({
			port,
			supabase: makeFakeSupabase(),
			getUserId: () => "user-1",
		});
		const runListRes = await executeAction(runListAction, {
			repo: "anguspersonal/ahOS",
			branch: "feat/test",
		});
		expect(runListRes.items).toHaveLength(1);
		{
			const parsed = runListAction.outputSchema.safeParse(runListRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		const jobListAction = createGithubRunJobListAction({
			port,
			supabase: makeFakeSupabase(),
			getUserId: () => "user-1",
		});
		const jobListRes = await executeAction(jobListAction, {
			repo: "anguspersonal/ahOS",
			run_id: 1001,
		});
		expect(jobListRes.items).toHaveLength(1);
		{
			const parsed = jobListAction.outputSchema.safeParse(jobListRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});
});


import { describe, expect, it, vi } from "vitest";
import { createOctokitGithubReadAdapter } from "./reads.js";

describe("OctokitGithubReadAdapter", () => {
	it("sends Accept: application/vnd.github.v3.diff and X-GitHub-Api-Version: 2022-11-28 on getPullDiff", async () => {
		const seenHeaders: Array<Record<string, string>> = [];
		const fakeFetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
			const h: Record<string, string> = {};
			if (init?.headers) {
				const headersObj = new Headers(init.headers as HeadersInit);
				headersObj.forEach((v, k) => {
					h[k.toLowerCase()] = v;
				});
			}
			seenHeaders.push(h);
			return new Response("diff --git a/file.ts b/file.ts\n", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});

		const adapter = createOctokitGithubReadAdapter(() => "ghp_secret_read_token", {
			fetch: fakeFetch,
		});

		const diff = await adapter.getPullDiff("anguspersonal/ahOS", 42);
		expect(diff).toContain("diff --git");
		expect(seenHeaders).toHaveLength(1);
		expect(seenHeaders[0]?.accept).toBe("application/vnd.github.v3.diff");
		expect(seenHeaders[0]?.["x-github-api-version"]).toBe("2022-11-28");
	});

	it("retries once on a secondary rate limit (429 with retry-after: 1)", async () => {
		let attempts = 0;
		const sleepMs: number[] = [];
		const fakeFetch: typeof globalThis.fetch = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "1",
					},
				});
			}
			return new Response("diff --git a/retry.ts b/retry.ts\n", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});

		const adapter = createOctokitGithubReadAdapter(() => "ghp_secret_read_token", {
			fetch: fakeFetch,
			sleep: async (ms) => {
				sleepMs.push(ms);
			},
		});

		const diff = await adapter.getPullDiff("anguspersonal/ahOS", 99);
		expect(diff).toContain("retry.ts");
		expect(attempts).toBe(2);
		expect(sleepMs).toEqual([1000]);
	});

	it("redacts the token from thrown error messages and names GITHUB_TOKEN_INGEST on 403", async () => {
		const secret = "ghp_super_secret_token_value_12345";
		const fakeFetch: typeof globalThis.fetch = vi.fn(async () => {
			return new Response(JSON.stringify({ message: `Bad credentials for ${secret}` }), {
				status: 403,
				headers: { "content-type": "application/json" },
			});
		});

		const adapter = createOctokitGithubReadAdapter(() => secret, {
			fetch: fakeFetch,
		});

		await expect(adapter.getPull("anguspersonal/ahOS", 7)).rejects.toSatisfy((err: unknown) => {
			const e = err as Error;
			expect(e.message).toContain("GITHUB_TOKEN_INGEST");
			expect(e.message).not.toContain(secret);
			return true;
		});
	});

	it("parses Link rel=\"next\" header into next_cursor on listPulls", async () => {
		const fakeFetch: typeof globalThis.fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify([
					{
						number: 11,
						title: "feat: list pulls",
						state: "open",
						draft: false,
						head: { ref: "feat/list" },
						base: { ref: "dev" },
						user: { login: "anguspersonal" },
						updated_at: "2026-10-19T10:00:00Z",
						html_url: "https://github.com/anguspersonal/ahOS/pull/11",
					},
				]),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
						link: '<https://api.github.com/repositories/1/pulls?per_page=30&page=2>; rel="next", <https://api.github.com/repositories/1/pulls?per_page=30&page=4>; rel="last"',
					},
				},
			);
		});

		const adapter = createOctokitGithubReadAdapter(() => "ghp_secret_read_token", {
			fetch: fakeFetch,
		});

		const res = await adapter.listPulls!("anguspersonal/ahOS", { state: "open", limit: 30, page: 1 });
		expect(res.next_cursor).toBe("2");
		expect(res.items).toEqual([
			{
				number: 11,
				title: "feat: list pulls",
				state: "open",
				draft: false,
				head_ref: "feat/list",
				base_ref: "dev",
				author: "anguspersonal",
				updated_at: "2026-10-19T10:00:00Z",
				html_url: "https://github.com/anguspersonal/ahOS/pull/11",
			},
		]);
	});

	it("maps getIssue, listIssueComments, listIssueTimeline, and searchIssues with Link pagination", async () => {
		const fakeFetch: typeof globalThis.fetch = vi.fn(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/comments")) {
				return new Response(
					JSON.stringify([
						{
							id: 501,
							user: { login: "angus" },
							created_at: "2026-10-19T00:00:00Z",
							updated_at: "2026-10-19T01:00:00Z",
							body: "Comment body",
							html_url: "https://github.com/anguspersonal/ahOS/issues/1#issuecomment-501",
						},
					]),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
							link: '<https://api.github.com/repos/anguspersonal/ahOS/issues/1/comments?page=2>; rel="next"',
						},
					},
				);
			}
			if (url.includes("/timeline")) {
				return new Response(
					JSON.stringify([
						{
							event: "labeled",
							actor: { login: "angus" },
							created_at: "2026-10-19T00:00:00Z",
							label: { name: "status:agent-ready" },
							body: "Must never be returned",
						},
					]),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}
			if (url.includes("/search/issues")) {
				return new Response(
					JSON.stringify({
						total_count: 1,
						incomplete_results: false,
						items: [
							{
								repository_url: "https://api.github.com/repos/anguspersonal/ahOS",
								number: 1,
								title: "Issue 1",
								state: "open",
								updated_at: "2026-10-19T00:00:00Z",
								html_url: "https://github.com/anguspersonal/ahOS/issues/1",
							},
						],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return new Response(
				JSON.stringify({
					number: 1,
					title: "Issue 1",
					state: "open",
					state_reason: null,
					labels: [{ name: "bug" }],
					assignees: [{ login: "angus" }],
					user: { login: "angus" },
					comments: 2,
					created_at: "2026-10-19T00:00:00Z",
					updated_at: "2026-10-19T00:00:00Z",
					closed_at: null,
					html_url: "https://github.com/anguspersonal/ahOS/issues/1",
					body: "Issue body",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});

		const adapter = createOctokitGithubReadAdapter(() => "ghp_secret_read_token", { fetch: fakeFetch });

		const issue = await adapter.getIssue!("anguspersonal/ahOS", 1);
		expect(issue.labels).toEqual(["bug"]);
		expect(issue.assignees).toEqual(["angus"]);

		const comments = await adapter.listIssueComments!("anguspersonal/ahOS", 1, { limit: 30, page: 1 });
		expect(comments.next_cursor).toBe("2");
		expect(comments.items[0]?.id).toBe(501);

		const timeline = await adapter.listIssueTimeline!("anguspersonal/ahOS", 1, { limit: 30, page: 1 });
		expect(timeline.items[0]?.label).toBe("status:agent-ready");
		expect((timeline.items[0] as any)?.body).toBeUndefined();

		const search = await adapter.searchIssues!("is:open", { limit: 30, page: 1 });
		expect(search.items[0]?.repo).toBe("anguspersonal/ahOS");
	});

	it("maps getRepository, getBranch (including 404 exists: false), getFile (raw + binary NUL check), and listDirectory", async () => {
		const fakeFetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const accept = new Headers(init?.headers as HeadersInit).get("accept") ?? "";

			if (url.endsWith("/branches/missing")) {
				return new Response(JSON.stringify({ message: "Branch not found" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.endsWith("/branches/dev")) {
				return new Response(
					JSON.stringify({
						name: "dev",
						commit: { sha: "abc1234" },
						protected: true,
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}
			if (url.includes("/contents/docs/README.md")) {
				if (accept.includes("application/vnd.github.raw")) {
					return new Response("# Docs Index\n", {
						status: 200,
						headers: { "content-type": "text/plain" },
					});
				}
				return new Response(
					JSON.stringify({
						type: "file",
						path: "docs/README.md",
						sha: "file-sha-1",
						size: 13,
						url: "https://api.github.com/repos/anguspersonal/ahOS/contents/docs/README.md?ref=dev",
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}
			if (url.includes("/contents/docs")) {
				return new Response(
					JSON.stringify([
						{ name: "README.md", path: "docs/README.md", type: "file", size: 13 },
					]),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return new Response(
				JSON.stringify({
					full_name: "anguspersonal/ahOS",
					private: true,
					default_branch: "dev",
					description: "ahOS repo",
					archived: false,
					pushed_at: "2026-10-19T00:00:00Z",
					open_issues_count: 10,
					html_url: "https://github.com/anguspersonal/ahOS",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});

		const adapter = createOctokitGithubReadAdapter(() => "ghp_secret_read_token", { fetch: fakeFetch });

		const repo = await adapter.getRepository!("anguspersonal/ahOS");
		expect(repo.default_branch).toBe("dev");

		const missingBranch = await adapter.getBranch!("anguspersonal/ahOS", "missing");
		expect(missingBranch).toEqual({ exists: false });

		const devBranch = await adapter.getBranch!("anguspersonal/ahOS", "dev");
		expect(devBranch).toEqual({ exists: true, name: "dev", sha: "abc1234", protected: true });

		const file = await adapter.getFile!("anguspersonal/ahOS", "docs/README.md");
		expect(file.binary).toBe(false);
		expect(file.text).toBe("# Docs Index\n");

		const dir = await adapter.listDirectory!("anguspersonal/ahOS", "docs");
		expect(dir).toHaveLength(1);
		expect(dir[0]?.name).toBe("README.md");
	});

	it("fetches the signed job log URL without an Authorization header and handles 410 expired logs", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const fakeFetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const h: Record<string, string> = {};
			if (init?.headers) {
				const headersObj = new Headers(init.headers as HeadersInit);
				headersObj.forEach((v, k) => {
					h[k.toLowerCase()] = v;
				});
			}
			calls.push({ url, headers: h });

			if (url.endsWith("/actions/jobs/101/logs")) {
				return new Response(null, {
					status: 302,
					headers: {
						location: "https://pipelines.actions.githubusercontent.com/signed-log-url",
					},
				});
			}
			if (url === "https://pipelines.actions.githubusercontent.com/signed-log-url") {
				return new Response("step 1 ok\nstep 2 failed\n", {
					status: 200,
					headers: { "content-type": "text/plain" },
				});
			}
			if (url.endsWith("/actions/jobs/410/logs")) {
				return new Response(null, { status: 410 });
			}
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		});

		const adapter = createOctokitGithubReadAdapter(() => "ghp_secret_read_token", {
			fetch: fakeFetch,
		});

		const logRes = await adapter.getJobLog!("anguspersonal/ahOS", 101);
		expect(logRes).toEqual({ log: "step 1 ok\nstep 2 failed\n" });
		expect(calls).toHaveLength(2);
		expect(calls[0]?.headers.authorization).toBe("token ghp_secret_read_token");
		expect(calls[1]?.url).toBe("https://pipelines.actions.githubusercontent.com/signed-log-url");
		expect(calls[1]?.headers.authorization).toBeUndefined();

		const expiredRes = await adapter.getJobLog!("anguspersonal/ahOS", 410);
		expect(expiredRes).toEqual({ expired: true });
	});

	it("names actions:read and GITHUB_TOKEN_INGEST when listWorkflowRuns fails with 403 Resource not accessible by personal access token", async () => {
		const fakeFetch: typeof globalThis.fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({ message: "Resource not accessible by personal access token" }),
				{
					status: 403,
					headers: { "content-type": "application/json" },
				},
			);
		});

		const adapter = createOctokitGithubReadAdapter(() => "ghp_secret_read_token", {
			fetch: fakeFetch,
		});

		await expect(
			adapter.listWorkflowRuns!("anguspersonal/ahOS", { branch: "dev", limit: 20, page: 1 }),
		).rejects.toSatisfy((err: unknown) => {
			const e = err as Error;
			expect(e.message).toContain("actions:read");
			expect(e.message).toContain("GITHUB_TOKEN_INGEST");
			return true;
		});
	});

	it("passes repo to tokenResolver across repo-scoped reads and infers example-org/* from searchIssues queries", async () => {
		const seenRepos: Array<string | undefined> = [];
		const seenAuthHeaders: Array<string | undefined> = [];
		const fakeFetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
			const headersObj = new Headers(init?.headers as HeadersInit);
			seenAuthHeaders.push(headersObj.get("authorization") ?? undefined);
			return new Response(
				JSON.stringify({
					total_count: 0,
					incomplete_results: false,
					items: [],
					full_name: "example-org/work",
					private: true,
					default_branch: "main",
					archived: false,
					open_issues_count: 0,
					html_url: "https://github.com/example-org/work",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const adapter = createOctokitGithubReadAdapter(
			(repo) => {
				seenRepos.push(repo);
				return repo?.startsWith("example-org/") ? "ghp_work_token" : "ghp_personal_token";
			},
			{ fetch: fakeFetch },
		);

		await adapter.getRepository!("example-org/work");
		await adapter.searchIssues!("repo:example-org/web-app is:open", { limit: 10, page: 1 });
		await adapter.searchIssues!("org:example-org label:bug", { limit: 10, page: 1 });
		await adapter.searchIssues!("repo:anguspersonal/ahOS is:open", { limit: 10, page: 1 });

		expect(seenRepos).toEqual([
			"example-org/work",
			"example-org/web-app",
			"example-org/*",
			"anguspersonal/ahOS",
		]);
		expect(seenAuthHeaders).toEqual([
			"token ghp_work_token",
			"token ghp_work_token",
			"token ghp_work_token",
			"token ghp_personal_token",
		]);
	});
});

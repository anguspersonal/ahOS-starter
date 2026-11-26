import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubActivityAdapter, describeItem, type GithubItem } from "./activity.js";

function item(over: Partial<GithubItem> = {}): GithubItem {
	return {
		url: "https://github.com/angus/ahOS/pull/42",
		number: 42,
		repo: "angus/ahOS",
		title: "Stop the ritual timing out on 80 rows",
		body: "Split the query in two.\n\nCloses #40.",
		state: "closed",
		isPullRequest: true,
		merged: true,
		author: "angus",
		labels: ["perf", "ritual"],
		createdAt: "2026-08-29T10:00:00Z",
		updatedAt: "2026-08-30T14:22:00Z",
		closedAt: "2026-08-30T14:22:00Z",
		comments: 3,
		involvement: ["authored", "commented"],
		...over,
	};
}

describe("createGithubActivityAdapter (#1531)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("runs author: and commenter: (not involves:), merges duplicates with both involvement reasons, and parses PR vs issue from the pull_request field", async () => {
		const queries: string[] = [];
		const fetchMock = vi.fn(async (input: unknown) => {
			const u = new URL(String(input));
			queries.push(u.searchParams.get("q") ?? "");

			const isAuthor = (u.searchParams.get("q") ?? "").startsWith("author:");
			const items = isAuthor
				? [
						{
							html_url: "https://github.com/angus/ahOS/pull/42",
							number: 42,
							repository_url: "https://api.github.com/repos/angus/ahOS",
							title: "PR I opened and commented on",
							body: "body",
							state: "closed",
							pull_request: { merged_at: "2026-08-30T14:22:00Z" },
							user: { login: "angus" },
							labels: [{ name: "ship" }],
							created_at: "2026-08-29T00:00:00Z",
							updated_at: "2026-08-30T14:22:00Z",
							closed_at: "2026-08-30T14:22:00Z",
							comments: 2,
						},
					]
				: [
						{
							// Same URL -> should merge involvement rather than emit a second row.
							html_url: "https://github.com/angus/ahOS/pull/42",
							number: 42,
							repository_url: "https://api.github.com/repos/angus/ahOS",
							title: "PR I opened and commented on",
							state: "closed",
							pull_request: { merged_at: "2026-08-30T14:22:00Z" },
							updated_at: "2026-08-30T14:22:00Z",
						},
						{
							// Plain issue (no pull_request field) I only commented on, in a different repo.
							html_url: "https://github.com/other/thing/issues/7",
							number: 7,
							title: "Someone else's issue",
							state: "open",
							user: { login: "someone" },
							updated_at: "2026-08-31T09:00:00Z",
						},
					];
			return new Response(JSON.stringify({ items }), { status: 200 });
		});

		const adapter = createGithubActivityAdapter(async () => "ghp_test_token", {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		const out = await adapter.searchMyActivity({
			login: "angus",
			since: "2026-08-25",
			until: "2026-09-01",
			repo: "angus/ahOS",
			perQuery: 25,
		});

		// Two queries: author: and commenter:. Never involves: (which also matches mere mentions).
		expect(queries).toEqual([
			"author:angus updated:2026-08-25..2026-09-01 repo:angus/ahOS",
			"commenter:angus updated:2026-08-25..2026-09-01 repo:angus/ahOS",
		]);
		expect(queries.some((q) => q.includes("involves:"))).toBe(false);

		// Three wire items collapsed to two distinct URLs, sorted newest-updated first.
		expect(out.map((i) => i.url)).toEqual([
			"https://github.com/other/thing/issues/7",
			"https://github.com/angus/ahOS/pull/42",
		]);

		const [issue, pr] = out;
		// Fallback repo extraction from html_url when repository_url is absent.
		expect(issue?.repo).toBe("other/thing");
		expect(issue?.isPullRequest).toBe(false);
		expect(issue?.merged).toBe(false);
		expect(issue?.involvement).toEqual(["commented"]);

		expect(pr?.repo).toBe("angus/ahOS");
		expect(pr?.isPullRequest).toBe(true);
		expect(pr?.merged).toBe(true);
		expect(pr?.involvement).toEqual(["authored", "commented"]);
	});

	it("omits repo: and uses >=since when optional bounds are omitted", async () => {
		const queries: string[] = [];
		const fetchMock = vi.fn(async (input: unknown) => {
			queries.push(new URL(String(input)).searchParams.get("q") ?? "");
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		});

		const adapter = createGithubActivityAdapter(async () => "ghp_test_token", {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		await adapter.searchMyActivity({ login: "angus", since: "2026-08-25", perQuery: 30 });
		expect(queries).toEqual([
			"author:angus updated:>=2026-08-25",
			"commenter:angus updated:>=2026-08-25",
		]);
	});

	it("awaits the token function per request and passes the repo argument", async () => {
		const tokenCalls: Array<string | undefined> = [];
		const authHeaders: string[] = [];
		let counter = 0;

		const getToken = vi.fn(async (repo?: string) => {
			await Promise.resolve();
			tokenCalls.push(repo);
			counter += 1;
			return `ghp_dynamic_${counter}`;
		});

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			authHeaders.push(headers?.Authorization ?? "");
			const url = new URL(String(input));
			if (url.pathname === "/user") {
				return new Response(JSON.stringify({ login: "angus" }), { status: 200 });
			}
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		});

		const adapter = createGithubActivityAdapter(getToken, {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		const login = await adapter.getViewerLogin("example-org/work");
		expect(login).toBe("angus");
		await adapter.searchMyActivity({
			login: "angus",
			since: "2026-08-25",
			repo: "example-org/work",
			perQuery: 10,
		});

		expect(getToken).toHaveBeenCalledTimes(3);
		expect(tokenCalls).toEqual(["example-org/work", "example-org/work", "example-org/work"]);
		expect(authHeaders).toEqual([
			"Bearer ghp_dynamic_1",
			"Bearer ghp_dynamic_2",
			"Bearer ghp_dynamic_3",
		]);
	});

	it("rejects with the HTTP status on non-2xx responses and never leaks the token in errors", async () => {
		const secretToken = "ghp_super_secret_token_999";
		const fetchMock = vi.fn(async () => {
			return new Response(`Bad credentials for token ${secretToken} (rate limit exceeded)`, {
				status: 403,
				statusText: "Forbidden",
			});
		});

		const adapter = createGithubActivityAdapter(async () => secretToken, {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		let caught: (Error & { status?: number }) | undefined;
		try {
			await adapter.getViewerLogin();
		} catch (err) {
			caught = err as Error & { status?: number };
		}

		expect(caught).toBeDefined();
		expect(caught?.status).toBe(403);
		expect(caught?.message).toContain("GitHub GET /user failed (403):");
		expect(caught?.message).toContain("[REDACTED]");
		expect(caught?.message).not.toContain(secretToken);
	});

	it("redacts the token if fetch itself throws an error containing the token", async () => {
		const secretToken = "ghp_network_leak_token_123";
		const fetchMock = vi.fn(async () => {
			throw new Error(`Socket hang up with header Authorization: Bearer ${secretToken}`);
		});

		const adapter = createGithubActivityAdapter(async () => secretToken, {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		await expect(adapter.getViewerLogin()).rejects.toThrow(
			"Socket hang up with header Authorization: Bearer [REDACTED]",
		);
	});
});

describe("describeItem", () => {
	it("distinguishes merged PRs, unmerged PRs, and issues in the one-line summary", () => {
		expect(describeItem(item())).toBe(
			"angus/ahOS#42 Stop the ritual timing out on 80 rows (merged PR, authored and commented)",
		);
		expect(describeItem(item({ merged: false, state: "open", involvement: ["authored"] }))).toBe(
			"angus/ahOS#42 Stop the ritual timing out on 80 rows (open PR, authored)",
		);
		expect(
			describeItem(
				item({ isPullRequest: false, merged: false, state: "open", involvement: ["commented"] }),
			),
		).toBe("angus/ahOS#42 Stop the ritual timing out on 80 rows (open issue, commented)");
	});
});

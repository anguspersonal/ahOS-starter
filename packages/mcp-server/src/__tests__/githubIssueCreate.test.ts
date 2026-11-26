import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubIssueCreateActionWithDeps } from "../tools/githubIssueCreate.js";
import { toMcpTool } from "../actions/adapters/mcp.js";
import type { GithubIssuesPort } from "@ahkms/core";

vi.mock("../identity.js", () => ({
	getCurrentUserId: () => "11111111-1111-4111-8111-111111111111",
}));

describe("githubIssueCreate MCP tool integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockPort: GithubIssuesPort = {
		findOpenIssueByTitle: vi.fn(),
		createIssue: vi.fn(),
	};

	const mockSupabase = {
		from: vi.fn().mockReturnValue({
			select: vi.fn().mockReturnThis(),
			eq: vi.fn().mockReturnThis(),
			maybeSingle: vi.fn().mockResolvedValue({
				data: {
					enabled: true,
					config: {
						default_repo: "owner/repo",
						issue_repos: ["owner/repo"],
					},
				},
				error: null,
			}),
			insert: vi.fn().mockResolvedValue({ data: null, error: null }),
		}),
	};

	it("creates an issue and formats MCP response with repo and URL", async () => {
		vi.mocked(mockPort.findOpenIssueByTitle).mockResolvedValueOnce(null);
		vi.mocked(mockPort.createIssue).mockResolvedValueOnce({
			number: 42,
			url: "https://github.com/owner/repo/issues/42",
		});

		const action = createGithubIssueCreateActionWithDeps(
			mockPort,
			mockSupabase as any,
			() => "11111111-1111-4111-8111-111111111111",
		);

		const tool = toMcpTool(action);
		const response = await tool.handler({
			title: "Critical bug",
			body: "Something went wrong",
			labels: ["bug"],
		});

		expect(response.content).toHaveLength(1);
		expect(response.content[0].type).toBe("text");
		expect(response.content[0].text).toBe(
			"Created issue #42 in owner/repo: https://github.com/owner/repo/issues/42",
		);
		expect(mockPort.createIssue).toHaveBeenCalledWith(
			"owner/repo",
			expect.objectContaining({
				title: "Critical bug",
				body: "Something went wrong\n\n_Created via ahOS (mcp)_",
				labels: ["bug"],
			}),
		);
	});

	it("duplicate guard: returns found open issue without calling createIssue", async () => {
		vi.mocked(mockPort.findOpenIssueByTitle).mockResolvedValueOnce({
			number: 15,
			url: "https://github.com/owner/repo/issues/15",
		});

		const action = createGithubIssueCreateActionWithDeps(
			mockPort,
			mockSupabase as any,
			() => "11111111-1111-4111-8111-111111111111",
		);

		const tool = toMcpTool(action);
		const response = await tool.handler({
			repo: "owner/repo",
			title: "Already reported",
		});

		expect(response.content).toHaveLength(1);
		expect(response.content[0].text).toBe(
			"Found existing open issue #15 in owner/repo: https://github.com/owner/repo/issues/15",
		);
		expect(mockPort.createIssue).not.toHaveBeenCalled();
	});
});

describe("getCredential - GitHub issues token (#1366)", () => {
	async function freshGetCredential() {
		vi.resetModules();
		const mod = await import("../credentials.js");
		return mod.getCredential;
	}

	it("resolves GITHUB_PERSONAL_ACCESS_TOKEN for github_issues", async () => {
		delete process.env.GITHUB_TOKEN_ISSUES;
		delete process.env.GITHUB_ISSUES_TOKEN;
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "gh_issues_secret";

		const getCredential = await freshGetCredential();

		await expect(getCredential("github_issues")).resolves.toBe("gh_issues_secret");
	});

	it("throws naming GITHUB_PERSONAL_ACCESS_TOKEN when unset, never falling back to other tokens", async () => {
		delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
		delete process.env.GITHUB_TOKEN_ISSUES;
		delete process.env.GITHUB_ISSUES_TOKEN;
		process.env.GITHUB_TOKEN_INGEST = "gh_ingest_token";
		process.env.GITHUB_TOKEN = "gh_general_token";

		const getCredential = await freshGetCredential();

		const err = (await getCredential("github_issues").catch((e: unknown) => e)) as Error;

		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/GITHUB_PERSONAL_ACCESS_TOKEN.*is not set/);
		expect(err.message).not.toContain("gh_ingest_token");
		expect(err.message).not.toContain("gh_general_token");
	});

	it("accepts legacy GITHUB_ISSUES_TOKEN when GITHUB_PERSONAL_ACCESS_TOKEN and GITHUB_TOKEN_ISSUES are not set", async () => {
		delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
		delete process.env.GITHUB_TOKEN_ISSUES;
		process.env.GITHUB_ISSUES_TOKEN = "gh_legacy_issues_secret";

		const getCredential = await freshGetCredential();
		await expect(getCredential("github_issues")).resolves.toBe("gh_legacy_issues_secret");
	});
});

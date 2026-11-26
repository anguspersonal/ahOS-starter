import { beforeEach, describe, expect, it, vi } from "vitest";
import { OctokitGithubPullsAdapter } from "./pulls.js";

const mockPullsList = vi.fn();
const mockPullsCreate = vi.fn();
const mockPullsUpdate = vi.fn();
const mockPullsCreateReview = vi.fn();
const mockGitDeleteRef = vi.fn();
const mockReposGet = vi.fn();

vi.mock("@octokit/rest", () => ({
	Octokit: class MockOctokit {
		rest = {
			pulls: {
				list: mockPullsList,
				create: mockPullsCreate,
				update: mockPullsUpdate,
				createReview: mockPullsCreateReview,
			},
			git: {
				deleteRef: mockGitDeleteRef,
			},
			repos: {
				get: mockReposGet,
			},
		};
	},
}));

describe("OctokitGithubPullsAdapter", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when token is missing or repo format is invalid", async () => {
		const noToken = new OctokitGithubPullsAdapter(() => null);
		await expect(noToken.findOpenPull("owner/repo", "feat", "dev")).rejects.toThrow(
			"Missing github_pulls credential (GITHUB_TOKEN_PULLS)",
		);
		const adapter = new OctokitGithubPullsAdapter(() => "ghp_pulls");
		await expect(adapter.findOpenPull("bad-repo", "feat", "dev")).rejects.toThrow(
			'Invalid repo format "bad-repo". Expected "owner/repo".',
		);
	});

	it("finds an open PR for (head, base) and creates a PR", async () => {
		mockPullsList.mockResolvedValueOnce({
			data: [{ number: 12, html_url: "https://github.com/owner/repo/pull/12", head: { sha: "abc1234" } }],
		});
		mockPullsCreate.mockResolvedValueOnce({
			data: { number: 13, html_url: "https://github.com/owner/repo/pull/13", head: { sha: "def5678" } },
		});
		const adapter = new OctokitGithubPullsAdapter(() => "ghp_pulls");
		await expect(adapter.findOpenPull("owner/repo", "feat/x", "dev")).resolves.toEqual({
			number: 12,
			html_url: "https://github.com/owner/repo/pull/12",
			head_sha: "abc1234",
		});
		expect(mockPullsList).toHaveBeenCalledWith({
			owner: "owner",
			repo: "repo",
			state: "open",
			head: "owner:feat/x",
			base: "dev",
			per_page: 10,
		});
		await expect(
			adapter.createPull("owner/repo", { title: "Title", head: "feat/x", base: "dev", body: "Body", draft: true }),
		).resolves.toEqual({ number: 13, html_url: "https://github.com/owner/repo/pull/13", head_sha: "def5678" });
	});

	it("updates a PR and closes a PR idempotently", async () => {
		mockPullsUpdate
			.mockResolvedValueOnce({
				data: { number: 12, title: "New title", state: "open", html_url: "https://github.com/owner/repo/pull/12" },
			})
			.mockResolvedValueOnce({
				data: { number: 12, state: "closed", html_url: "https://github.com/owner/repo/pull/12" },
			});
		const adapter = new OctokitGithubPullsAdapter(() => "ghp_pulls");
		await expect(adapter.updatePull("owner/repo", 12, { title: "New title" })).resolves.toEqual({
			number: 12,
			title: "New title",
			state: "open",
			html_url: "https://github.com/owner/repo/pull/12",
		});
		await expect(adapter.closePull("owner/repo", 12)).resolves.toEqual({ number: 12, state: "closed" });
		expect(mockPullsUpdate).toHaveBeenLastCalledWith({
			owner: "owner",
			repo: "repo",
			pull_number: 12,
			state: "closed",
		});
	});

	it("passes repo to tokenResolver so example-org/* PR writes resolve the Work token", async () => {
		const seenRepos: Array<string | undefined> = [];
		const adapter = new OctokitGithubPullsAdapter((repo) => {
			seenRepos.push(repo);
			return repo?.startsWith("example-org/") ? "ghp_work" : "ghp_personal";
		});
		mockPullsCreate.mockResolvedValueOnce({
			data: { number: 5, html_url: "https://github.com/example-org/work/pull/5", head: { sha: "123" } },
		});
		await adapter.createPull("example-org/work", {
			title: "feat: work",
			head: "feat/work",
			base: "dev",
		});
		expect(seenRepos).toEqual(["example-org/work"]);
	});

	it("creates a PR review and maps 422 self-review errors to a clear message (#1507)", async () => {
		const adapter = new OctokitGithubPullsAdapter(() => "ghp_pulls");
		mockPullsCreateReview.mockResolvedValueOnce({
			data: { id: 901, html_url: "https://github.com/owner/repo/pull/12#pullrequestreview-901", state: "COMMENTED" },
		});
		await expect(
			adapter.createReview("owner/repo", 12, { event: "COMMENT", body: "Looks good overall" }),
		).resolves.toEqual({
			id: 901,
			html_url: "https://github.com/owner/repo/pull/12#pullrequestreview-901",
			state: "COMMENTED",
		});

		mockPullsCreateReview.mockRejectedValueOnce(
			Object.assign(new Error("Unprocessable Entity: Can not approve your own pull request"), { status: 422 }),
		);
		await expect(adapter.createReview("owner/repo", 12, { event: "APPROVE" })).rejects.toThrow(
			"GitHub does not let the PR's author approve or request changes on it",
		);
	});

	it("lists open PRs from head and deletes a branch, handling 422 missing ref and protected branch (#1507)", async () => {
		const adapter = new OctokitGithubPullsAdapter(() => "ghp_pulls");
		mockPullsList.mockResolvedValueOnce({
			data: [{ number: 18, html_url: "https://github.com/owner/repo/pull/18", head: { sha: "789" } }],
		});
		await expect(adapter.listOpenPullsFromHead("owner/repo", "feat/branch")).resolves.toEqual([
			{ number: 18, html_url: "https://github.com/owner/repo/pull/18", head_sha: "789" },
		]);

		mockGitDeleteRef.mockResolvedValueOnce({});
		await expect(adapter.deleteBranch("owner/repo", "feat/branch")).resolves.toEqual({ deleted: true });
		expect(mockGitDeleteRef).toHaveBeenCalledWith({
			owner: "owner",
			repo: "repo",
			ref: "heads/feat/branch",
		});

		mockGitDeleteRef.mockRejectedValueOnce(
			Object.assign(new Error("Reference does not exist"), { status: 422 }),
		);
		await expect(adapter.deleteBranch("owner/repo", "feat/gone")).resolves.toEqual({ deleted: false });

		mockGitDeleteRef.mockRejectedValueOnce(
			Object.assign(new Error("Cannot delete protected branch"), { status: 422 }),
		);
		await expect(adapter.deleteBranch("owner/repo", "release/v1")).rejects.toThrow(/protected branch/i);
	});
});

import { describe, expect, it, vi } from "vitest";
import { OctokitGithubIssuesAdapter } from "./index.js";

const mockListForRepo = vi.fn();
const mockCreate = vi.fn();
const mockCreateComment = vi.fn();
const mockAddLabels = vi.fn();
const mockRemoveLabel = vi.fn();

vi.mock("@octokit/rest", () => {
	return {
		Octokit: class MockOctokit {
			auth: string;
			rest = {
				issues: {
					listForRepo: mockListForRepo,
					create: mockCreate,
					createComment: mockCreateComment,
					addLabels: mockAddLabels,
					removeLabel: mockRemoveLabel,
				},
			};
			constructor(opts: { auth: string }) {
				this.auth = opts.auth;
			}
		},
	};
});

describe("OctokitGithubIssuesAdapter", () => {
	it("throws if token resolver returns null or empty string", async () => {
		const adapter = new OctokitGithubIssuesAdapter(() => null);
		await expect(
			adapter.findOpenIssueByTitle("owner/repo", "Bug title"),
		).rejects.toThrow("Missing github_issues credential (GITHUB_PERSONAL_ACCESS_TOKEN)");

		const adapterEmpty = new OctokitGithubIssuesAdapter(async () => "   ");
		await expect(
			adapterEmpty.createIssue("owner/repo", { title: "Bug title" }),
		).rejects.toThrow("Missing github_issues credential (GITHUB_PERSONAL_ACCESS_TOKEN)");
	});

	it("throws if repo format is invalid", async () => {
		const adapter = new OctokitGithubIssuesAdapter(() => "fake-token");
		await expect(
			adapter.findOpenIssueByTitle("invalid-repo", "Bug title"),
		).rejects.toThrow('Invalid repo format "invalid-repo". Expected "owner/repo".');
	});

	it("finds open issue matching exact title, ignoring PRs", async () => {
		mockListForRepo.mockResolvedValueOnce({
			data: [
				{
					number: 1,
					title: "Other issue",
					html_url: "https://github.com/owner/repo/issues/1",
				},
				{
					number: 2,
					title: "Bug title",
					pull_request: {},
					html_url: "https://github.com/owner/repo/pull/2",
				},
				{
					number: 3,
					title: "Bug title",
					html_url: "https://github.com/owner/repo/issues/3",
				},
			],
		});

		const adapter = new OctokitGithubIssuesAdapter(() => "test-token");
		const match = await adapter.findOpenIssueByTitle("owner/repo", "Bug title");

		expect(mockListForRepo).toHaveBeenCalledWith({
			owner: "owner",
			repo: "repo",
			state: "open",
			per_page: 100,
			page: 1,
		});
		expect(match).toEqual({
			number: 3,
			url: "https://github.com/owner/repo/issues/3",
		});
	});

	it("paginates findOpenIssueByTitle across 100-item pages until match is found on page 2", async () => {
		mockListForRepo.mockClear();
		const page1 = Array.from({ length: 100 }, (_, idx) => ({
			number: idx + 1,
			title: `Issue ${idx + 1}`,
			html_url: `https://github.com/owner/repo/issues/${idx + 1}`,
		}));
		const page2 = [
			{
				number: 101,
				title: "Page two target",
				html_url: "https://github.com/owner/repo/issues/101",
			},
		];

		mockListForRepo
			.mockResolvedValueOnce({ data: page1 })
			.mockResolvedValueOnce({ data: page2 });

		const adapter = new OctokitGithubIssuesAdapter(() => "test-token");
		const match = await adapter.findOpenIssueByTitle("owner/repo", "Page two target");

		expect(mockListForRepo).toHaveBeenNthCalledWith(1, {
			owner: "owner",
			repo: "repo",
			state: "open",
			per_page: 100,
			page: 1,
		});
		expect(mockListForRepo).toHaveBeenNthCalledWith(2, {
			owner: "owner",
			repo: "repo",
			state: "open",
			per_page: 100,
			page: 2,
		});
		expect(match).toEqual({
			number: 101,
			url: "https://github.com/owner/repo/issues/101",
		});
	});

	it("returns null if no open issue matches title", async () => {
		mockListForRepo.mockResolvedValueOnce({
			data: [
				{
					number: 1,
					title: "Different title",
					html_url: "https://github.com/owner/repo/issues/1",
				},
			],
		});

		const adapter = new OctokitGithubIssuesAdapter(() => "test-token");
		const match = await adapter.findOpenIssueByTitle("owner/repo", "Nonexistent");
		expect(match).toBeNull();
	});

	it("creates an issue and passes title, body, and labels", async () => {
		mockCreate.mockResolvedValueOnce({
			data: {
				number: 42,
				html_url: "https://github.com/owner/repo/issues/42",
			},
		});

		const adapter = new OctokitGithubIssuesAdapter(() => "test-token");
		const result = await adapter.createIssue("owner/repo", {
			title: "New feature",
			body: "Details about feature",
			labels: ["enhancement"],
		});

		expect(mockCreate).toHaveBeenCalledWith({
			owner: "owner",
			repo: "repo",
			title: "New feature",
			body: "Details about feature",
			labels: ["enhancement"],
		});
		expect(result).toEqual({
			number: 42,
			url: "https://github.com/owner/repo/issues/42",
		});
	});

	it("creates a comment, adds labels, and handles removeLabel including 404 as removed: false", async () => {
		mockCreateComment.mockResolvedValueOnce({
			data: {
				id: 9001,
				html_url: "https://github.com/owner/repo/issues/42#issuecomment-9001",
			},
		});
		mockAddLabels.mockResolvedValueOnce({
			data: [{ name: "qa:ready" }, { name: "bug" }],
		});
		mockRemoveLabel.mockResolvedValueOnce({ data: [] });

		const adapter = new OctokitGithubIssuesAdapter(() => "test-token");

		const comment = await adapter.createComment("owner/repo", 42, "Comment body");
		expect(comment).toEqual({
			id: 9001,
			html_url: "https://github.com/owner/repo/issues/42#issuecomment-9001",
		});

		const added = await adapter.addLabels("owner/repo", 42, ["qa:ready", "bug"]);
		expect(added).toEqual({ labels: ["qa:ready", "bug"] });

		const removed = await adapter.removeLabel("owner/repo", 42, "qa:ready");
		expect(removed).toEqual({ removed: true });

		mockRemoveLabel.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
		const missingRemoved = await adapter.removeLabel("owner/repo", 42, "nonexistent");
		expect(missingRemoved).toEqual({ removed: false });
	});

	it("passes the target repo to tokenResolver so example-org/* repos can resolve GITHUB_WORK_ACCESS_TOKEN", async () => {
		const seenRepos: Array<string | undefined> = [];
		const resolver = vi.fn(async (repo?: string) => {
			seenRepos.push(repo);
			return repo?.startsWith("example-org/") ? "ghp_work_token" : "ghp_personal_token";
		});
		const adapter = new OctokitGithubIssuesAdapter(resolver);

		mockCreate.mockResolvedValueOnce({
			data: { number: 1, html_url: "https://github.com/example-org/work/issues/1" },
		});
		mockCreateComment.mockResolvedValueOnce({
			data: { id: 10, html_url: "https://github.com/anguspersonal/ahOS/issues/2#issuecomment-10" },
		});

		await adapter.createIssue("example-org/work", { title: "Work issue" });
		await adapter.createComment("anguspersonal/ahOS", 2, "Personal comment");

		expect(seenRepos).toEqual(["example-org/work", "anguspersonal/ahOS"]);
	});
});

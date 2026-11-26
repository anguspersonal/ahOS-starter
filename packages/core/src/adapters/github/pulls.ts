import { Octokit } from "@octokit/rest";
import type {
	CreatePullInput,
	CreatePullReviewInput,
	GithubPullsPort,
	GithubRepositoryRead,
	PullRef,
	PullReviewRef,
	UpdatedPullRef,
	UpdatePullInput,
} from "../../ports/github.js";
import type { GithubTokenResolver } from "./index.js";

export const SELF_REVIEW_ERROR_MESSAGE =
	"GitHub does not let the PR's author approve or request changes on it";

export function extractGithubPullsErrorMessage(err: unknown): string {
	const parts: string[] = [];
	if (err instanceof Error && err.message) parts.push(err.message);
	const data = (
		err as { response?: { data?: { message?: string; errors?: Array<string | { message?: string }> } } }
	)?.response?.data;
	if (typeof data?.message === "string" && data.message) parts.push(data.message);
	if (Array.isArray(data?.errors)) {
		for (const item of data.errors) {
			if (typeof item === "string") parts.push(item);
			else if (item && typeof item.message === "string") parts.push(item.message);
		}
	}
	return parts.join(" — ") || String(err);
}

export class OctokitGithubPullsAdapter implements GithubPullsPort {
	constructor(private readonly tokenResolver: GithubTokenResolver) {}

	private async client(repo: string): Promise<{ octokit: Octokit; owner: string; repo: string }> {
		const [owner, repoName, extra] = repo.split("/");
		if (!owner || !repoName || extra !== undefined) {
			throw new Error(`Invalid repo format "${repo}". Expected "owner/repo".`);
		}
		const token = await this.tokenResolver(repo);
		if (!token || typeof token !== "string" || token.trim().length === 0) {
			throw new Error("Missing github_pulls credential (GITHUB_TOKEN_PULLS)");
		}
		return { octokit: new Octokit({ auth: token.trim() }), owner, repo: repoName };
	}

	async findOpenPull(repo: string, head: string, base: string): Promise<PullRef | null> {
		const { octokit, owner, repo: repoName } = await this.client(repo);
		const { data } = await octokit.rest.pulls.list({
			owner,
			repo: repoName,
			state: "open",
			head: head.includes(":") ? head : `${owner}:${head}`,
			base,
			per_page: 10,
		});
		const m = data[0];
		return m ? { number: m.number, html_url: m.html_url, head_sha: m.head?.sha ?? "" } : null;
	}

	async createPull(repo: string, input: CreatePullInput): Promise<PullRef> {
		const { octokit, owner, repo: repoName } = await this.client(repo);
		const { data } = await octokit.rest.pulls.create({
			owner,
			repo: repoName,
			title: input.title,
			head: input.head,
			base: input.base,
			body: input.body,
			draft: input.draft ?? true,
		});
		return { number: data.number, html_url: data.html_url, head_sha: data.head?.sha ?? "" };
	}

	async updatePull(repo: string, number: number, patch: UpdatePullInput): Promise<UpdatedPullRef> {
		const { octokit, owner, repo: repoName } = await this.client(repo);
		const { data } = await octokit.rest.pulls.update({
			owner,
			repo: repoName,
			pull_number: number,
			...(patch.title !== undefined ? { title: patch.title } : {}),
			...(patch.body !== undefined ? { body: patch.body } : {}),
		});
		return { number: data.number, title: data.title, state: data.state, html_url: data.html_url };
	}

	async closePull(repo: string, number: number): Promise<{ number: number; state: string }> {
		const { octokit, owner, repo: repoName } = await this.client(repo);
		const { data } = await octokit.rest.pulls.update({
			owner,
			repo: repoName,
			pull_number: number,
			state: "closed",
		});
		return { number: data.number, state: data.state };
	}

	async createReview(repo: string, number: number, input: CreatePullReviewInput): Promise<PullReviewRef> {
		const { octokit, owner, repo: repoName } = await this.client(repo);
		try {
			const { data } = await octokit.rest.pulls.createReview({
				owner,
				repo: repoName,
				pull_number: number,
				event: input.event,
				...(input.body !== undefined ? { body: input.body } : {}),
			});
			return { id: data.id, html_url: data.html_url, state: data.state };
		} catch (err) {
			const status = (err as { status?: number })?.status;
			if (status === 422 && (input.event === "APPROVE" || input.event === "REQUEST_CHANGES")) {
				throw new Error(SELF_REVIEW_ERROR_MESSAGE);
			}
			throw err;
		}
	}

	async createPullRequestReview(repo: string, number: number, input: CreatePullReviewInput): Promise<PullReviewRef> {
		return this.createReview(repo, number, input);
	}

	async listOpenPullsFromHead(repo: string, head: string): Promise<PullRef[]> {
		const { octokit, owner, repo: repoName } = await this.client(repo);
		const normalizedHead = head.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
		const { data } = await octokit.rest.pulls.list({
			owner,
			repo: repoName,
			state: "open",
			head: normalizedHead.includes(":") ? normalizedHead : `${owner}:${normalizedHead}`,
			per_page: 10,
		});
		return data.map((m) => ({
			number: m.number,
			html_url: m.html_url,
			head_sha: m.head?.sha ?? "",
		}));
	}

	async deleteBranch(repo: string, branch: string): Promise<{ deleted: boolean }> {
		const { octokit, owner, repo: repoName } = await this.client(repo);
		const normalizedBranch = branch.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
		try {
			await octokit.rest.git.deleteRef({
				owner,
				repo: repoName,
				ref: `heads/${normalizedBranch}`,
			});
			return { deleted: true };
		} catch (err) {
			const status = (err as { status?: number })?.status;
			const msg = extractGithubPullsErrorMessage(err);
			if (status === 422 && /reference does not exist/i.test(msg)) {
				return { deleted: false };
			}
			if (status === 422) {
				throw Object.assign(
					new Error(`Cannot delete branch "${normalizedBranch}" in ${repo} (protected branch): ${msg}`),
					{ status: 422 },
				);
			}
			throw err;
		}
	}

	async getRepository(repo: string): Promise<GithubRepositoryRead> {
		const { octokit, owner, repo: repoName } = await this.client(repo);
		const { data } = await octokit.rest.repos.get({
			owner,
			repo: repoName,
		});
		return {
			full_name: data.full_name,
			private: Boolean(data.private),
			default_branch: data.default_branch,
			description: data.description ?? null,
			archived: Boolean(data.archived),
			pushed_at: data.pushed_at ?? null,
			open_issues_count: data.open_issues_count ?? 0,
			html_url: data.html_url,
		};
	}
}

export function createOctokitGithubPullsAdapter(tokenResolver: GithubTokenResolver): GithubPullsPort {
	return new OctokitGithubPullsAdapter(tokenResolver);
}

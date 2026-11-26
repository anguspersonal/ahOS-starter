import { Octokit } from "@octokit/rest";
import type { CreateIssueInput, GithubIssuesPort, IssueRef } from "../../ports/github.js";

export type GithubTokenResolver = (
	repo?: string,
) => Promise<string | null | undefined> | string | null | undefined;

/**
 * Adapter wrapping @octokit/rest for GitHub issue operations (ADR-101 §1, §4).
 * Receives a token resolver function; never reads process.env directly.
 */
export class OctokitGithubIssuesAdapter implements GithubIssuesPort {
	constructor(private readonly tokenResolver: GithubTokenResolver) {}

	private async resolveToken(repo: string): Promise<string> {
		const token = await this.tokenResolver(repo);
		if (!token || typeof token !== "string" || token.trim().length === 0) {
			throw new Error("Missing github_issues credential (GITHUB_PERSONAL_ACCESS_TOKEN)");
		}
		return token.trim();
	}

	private parseRepo(repo: string): { owner: string; repo: string } {
		const parts = repo.split("/");
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			throw new Error(`Invalid repo format "${repo}". Expected "owner/repo".`);
		}
		return { owner: parts[0], repo: parts[1] };
	}

	async findOpenIssueByTitle(repo: string, title: string): Promise<IssueRef | null> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);
		const octokit = new Octokit({ auth: token });

		for (let page = 1; ; page++) {
			const { data } = await octokit.rest.issues.listForRepo({
				owner,
				repo: repoName,
				state: "open",
				per_page: 100,
				page,
			});

			const match = data.find((i) => i.title === title && !i.pull_request);
			if (match) {
				return {
					number: match.number,
					url: match.html_url,
				};
			}

			if (data.length < 100) {
				return null;
			}
		}
	}

	async createIssue(repo: string, input: CreateIssueInput): Promise<IssueRef> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);
		const octokit = new Octokit({ auth: token });

		const { data } = await octokit.rest.issues.create({
			owner,
			repo: repoName,
			title: input.title,
			body: input.body,
			labels: input.labels,
		});

		return {
			number: data.number,
			url: data.html_url,
		};
	}

	async createComment(
		repo: string,
		number: number,
		body: string,
	): Promise<{ id: number; html_url: string }> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);
		const octokit = new Octokit({ auth: token });

		const { data } = await octokit.rest.issues.createComment({
			owner,
			repo: repoName,
			issue_number: number,
			body,
		});

		return {
			id: data.id,
			html_url: data.html_url,
		};
	}

	async addLabels(
		repo: string,
		number: number,
		labels: string[],
	): Promise<{ labels: string[] }> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);
		const octokit = new Octokit({ auth: token });

		const { data } = await octokit.rest.issues.addLabels({
			owner,
			repo: repoName,
			issue_number: number,
			labels,
		});

		return {
			labels: data.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
		};
	}

	async removeLabel(
		repo: string,
		number: number,
		label: string,
	): Promise<{ removed: boolean }> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);
		const octokit = new Octokit({ auth: token });

		try {
			await octokit.rest.issues.removeLabel({
				owner,
				repo: repoName,
				issue_number: number,
				name: label,
			});
			return { removed: true };
		} catch (err) {
			if ((err as { status?: number })?.status === 404) {
				return { removed: false };
			}
			throw err;
		}
	}
}

export function createOctokitGithubIssuesAdapter(
	tokenResolver: GithubTokenResolver,
): GithubIssuesPort {
	return new OctokitGithubIssuesAdapter(tokenResolver);
}

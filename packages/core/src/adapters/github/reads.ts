import { Octokit } from "@octokit/rest";
import {
	encodeRepoPathSegments,
	type GithubBranchRead,
	type GithubDirEntry,
	type GithubFileRead,
	type GithubIssueCommentItem,
	type GithubIssueRead,
	type GithubIssueSearchItem,
	type GithubIssueSearchResult,
	type GithubIssueTimelineItem,
	type GithubJobLogRead,
	type GithubListWorkflowRunJobsOptions,
	type GithubListWorkflowRunsOptions,
	type GithubPagedResult,
	type GithubPullCommitItem,
	type GithubPullFileItem,
	type GithubPullListItem,
	type GithubPullRequestRead,
	type GithubPullReviewItem,
	type GithubReadPort,
	type GithubRepositoryRead,
	type GithubWorkflowJobListResult,
	type GithubWorkflowRunListResult,
	type ListPullsParams,
} from "../../ports/github.js";
import type { GithubTokenResolver } from "./index.js";

export { encodeRepoPathSegments };

export interface GithubReadAdapterOptions {
	fetch?: typeof globalThis.fetch;
	sleep?: (ms: number) => Promise<void>;
	baseUrl?: string;
}

export class GithubReadApiError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "GithubReadApiError";
		this.status = status;
	}
}

function redactToken(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join("[REDACTED]");
}

function getHeader(headers: Record<string, unknown> | Headers | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	if (typeof (headers as Headers).get === "function") {
		return (headers as Headers).get(name) ?? (headers as Headers).get(lower) ?? undefined;
	}
	const rec = headers as Record<string, unknown>;
	for (const [k, v] of Object.entries(rec)) {
		if (k.toLowerCase() === lower && v != null) {
			return String(v);
		}
	}
	return undefined;
}

export function parseNextCursorFromLink(linkHeader: string | undefined): string | null {
	if (!linkHeader) return null;
	const parts = linkHeader.split(",");
	for (const part of parts) {
		if (!/;\s*rel=["']?next["']?/i.test(part)) continue;
		const urlMatch = part.match(/<([^>]+)>/);
		if (!urlMatch?.[1]) continue;
		try {
			const url = new URL(urlMatch[1], "https://api.github.com");
			const page = url.searchParams.get("page");
			if (page) return page;
		} catch {
			const m = urlMatch[1].match(/[?&]page=(\d+)/);
			if (m?.[1]) return m[1];
		}
	}
	return null;
}

function parseRepoFromUrl(repositoryUrl: string | undefined, htmlUrl: string | undefined): string {
	if (repositoryUrl) {
		const m = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
		if (m?.[1]) return m[1];
	}
	if (htmlUrl) {
		const m = htmlUrl.match(/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\//);
		if (m?.[1]) return m[1];
	}
	return "";
}

const MAX_READABLE_FILE_BYTES = 1_048_576;
const BINARY_SNIFF_BYTES = 8_192;

function hasNullByteInFirst8KB(text: string): boolean {
	const slice = text.slice(0, BINARY_SNIFF_BYTES);
	return slice.includes("\0");
}

function hasNextPageLink(linkHeader: string | undefined): boolean {
	if (!linkHeader) return false;
	return /<[^>]+>;\s*rel="next"/i.test(linkHeader);
}

function inferRepoFromSearchQuery(query: string): string | undefined {
	const repoMatch = query.match(/\brepo:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/i);
	if (repoMatch?.[1]) return repoMatch[1];
	const ownerMatch = query.match(/\b(?:org|user):([a-zA-Z0-9_.-]+)/i);
	if (ownerMatch?.[1]) return `${ownerMatch[1]}/*`;
	return undefined;
}

export class OctokitGithubReadAdapter implements GithubReadPort {
	private readonly fetchImpl?: typeof globalThis.fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly baseUrl: string;

	constructor(
		private readonly tokenResolver: GithubTokenResolver,
		options?: GithubReadAdapterOptions,
	) {
		this.fetchImpl = options?.fetch;
		this.sleep = options?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.baseUrl = options?.baseUrl ?? "https://api.github.com";
	}

	private async resolveToken(repo?: string): Promise<string> {
		const token = await this.tokenResolver(repo);
		if (!token || typeof token !== "string" || token.trim().length === 0) {
			throw new Error("Missing GITHUB_TOKEN_INGEST credential for GitHub read operations");
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

	private createOctokit(token: string): Octokit {
		return new Octokit({
			auth: token,
			baseUrl: this.baseUrl,
			request: this.fetchImpl ? { fetch: this.fetchImpl } : undefined,
		});
	}

	private async runWithRetry<T>(
		token: string,
		targetLabel: string,
		requiredPermission: string,
		fn: (octokit: Octokit) => Promise<T>,
		options?: { isSearch?: boolean },
	): Promise<T> {
		const octokit = this.createOctokit(token);
		let secondaryRetried = false;
		let serverRetries = 0;

		while (true) {
			try {
				return await fn(octokit);
			} catch (err: unknown) {
				const status = typeof (err as any)?.status === "number" ? ((err as any).status as number) : 500;
				const headers = (err as any)?.response?.headers as Record<string, unknown> | undefined;
				const rawMsg = err instanceof Error ? err.message : String(err);
				const safeMsg = redactToken(rawMsg, token);

				if (status === 404 || status === 410) {
					throw new GithubReadApiError(`not found, or not visible to the read token: ${targetLabel}`, status);
				}

				const retryAfterHeader = getHeader(headers, "retry-after");
				if ((status === 403 || status === 429) && retryAfterHeader !== undefined) {
					if (!secondaryRetried) {
						secondaryRetried = true;
						const parsedSecs = Number.parseInt(retryAfterHeader, 10);
						const waitSecs = Number.isFinite(parsedSecs) && parsedSecs > 0 ? Math.min(parsedSecs, 60) : 1;
						await this.sleep(waitSecs * 1000);
						continue;
					}
					const searchNote = options?.isSearch ? " (search rate limit: 30/minute authenticated)" : "";
					throw new GithubReadApiError(
						`GitHub secondary rate limit exceeded (${status})${searchNote} on ${targetLabel} using GITHUB_TOKEN_INGEST: ${safeMsg}`,
						status,
					);
				}

				const remaining = getHeader(headers, "x-ratelimit-remaining");
				if (status === 403 && remaining === "0") {
					const resetEpoch = getHeader(headers, "x-ratelimit-reset");
					const resetIso =
						resetEpoch && Number.isFinite(Number(resetEpoch))
							? new Date(Number(resetEpoch) * 1000).toISOString()
							: (resetEpoch ?? "unknown");
					const limitDesc = options?.isSearch
						? "GitHub search rate limit (30/minute authenticated) exhausted"
						: "GitHub primary rate limit exhausted";
					throw new GithubReadApiError(
						`${limitDesc} on GITHUB_TOKEN_INGEST (resets at ${resetIso}).`,
						403,
					);
				}

				if (status === 401 || status === 403) {
					const searchRateNote =
						options?.isSearch && status === 403
							? " or exceeded the GitHub search rate limit (30/minute authenticated)"
							: "";
					throw new GithubReadApiError(
						`GitHub ${status} error on ${targetLabel}: verify GITHUB_TOKEN_INGEST is valid and has ${requiredPermission} permission${searchRateNote} (${safeMsg}).`,
						status,
					);
				}

				if (status >= 500 && status < 600) {
					if (serverRetries < 2) {
						serverRetries += 1;
						await this.sleep(serverRetries * 200);
						continue;
					}
					throw new GithubReadApiError(`GitHub server error (${status}) on ${targetLabel}: ${safeMsg}`, status);
				}

				throw new GithubReadApiError(`GitHub API error (${status}) on ${targetLabel}: ${safeMsg}`, status);
			}
		}
	}

	async getPull(repo: string, number: number): Promise<GithubPullRequestRead> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(
			token,
			`${repo}#${number}`,
			"pull_requests:read and contents:read",
			async (octokit) => {
				const { data } = await octokit.rest.pulls.get({
					owner,
					repo: repoName,
					pull_number: number,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});

				return {
					number: data.number,
					title: data.title,
					state: data.state,
					draft: Boolean(data.draft),
					merged: Boolean(data.merged),
					head: {
						ref: data.head.ref,
						sha: data.head.sha,
					},
					base: {
						ref: data.base.ref,
						sha: data.base.sha,
					},
					author: data.user?.login ?? null,
					html_url: data.html_url,
					additions: data.additions,
					deletions: data.deletions,
					changed_files: data.changed_files,
					created_at: data.created_at,
					updated_at: data.updated_at,
					body: data.body ?? null,
					mergeable: data.mergeable ?? null,
					mergeable_state: data.mergeable_state ?? null,
				};
			},
		);
	}

	async getPullDiff(repo: string, number: number): Promise<string> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(
			token,
			`${repo}#${number}`,
			"pull_requests:read and contents:read",
			async (octokit) => {
				const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
					owner,
					repo: repoName,
					pull_number: number,
					headers: {
						accept: "application/vnd.github.v3.diff",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});

				return typeof response.data === "string" ? response.data : String(response.data ?? "");
			},
		);
	}

	async listPulls(repo: string, params: ListPullsParams): Promise<GithubPagedResult<GithubPullListItem>> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, repo, "pull_requests:read", async (octokit) => {
			const response = await octokit.rest.pulls.list({
				owner,
				repo: repoName,
				state: params.state ?? "open",
				head: params.head,
				base: params.base,
				per_page: params.limit,
				page: params.page,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const next_cursor = parseNextCursorFromLink(getHeader(response.headers as Record<string, unknown>, "link"));
			const items: GithubPullListItem[] = response.data.map((pr) => ({
				number: pr.number,
				title: pr.title,
				state: pr.state,
				draft: Boolean(pr.draft),
				head_ref: pr.head.ref,
				base_ref: pr.base.ref,
				author: pr.user?.login ?? null,
				updated_at: pr.updated_at,
				html_url: pr.html_url,
			}));

			return { items, next_cursor };
		});
	}

	async listPullFiles(
		repo: string,
		number: number,
		params: { limit: number; page: number },
	): Promise<GithubPagedResult<GithubPullFileItem>> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, `${repo}#${number}`, "pull_requests:read", async (octokit) => {
			const response = await octokit.rest.pulls.listFiles({
				owner,
				repo: repoName,
				pull_number: number,
				per_page: params.limit,
				page: params.page,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const next_cursor = parseNextCursorFromLink(getHeader(response.headers as Record<string, unknown>, "link"));
			const items: GithubPullFileItem[] = response.data.map((f) => ({
				filename: f.filename,
				status: f.status,
				additions: f.additions,
				deletions: f.deletions,
				changes: f.changes,
				previous_filename: f.previous_filename ?? null,
				patch: f.patch,
			}));

			return { items, next_cursor };
		});
	}

	async listPullCommits(
		repo: string,
		number: number,
		params: { limit: number; page: number },
	): Promise<GithubPagedResult<GithubPullCommitItem>> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, `${repo}#${number}`, "pull_requests:read", async (octokit) => {
			const response = await octokit.rest.pulls.listCommits({
				owner,
				repo: repoName,
				pull_number: number,
				per_page: params.limit,
				page: params.page,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const next_cursor = parseNextCursorFromLink(getHeader(response.headers as Record<string, unknown>, "link"));
			const items: GithubPullCommitItem[] = response.data.map((c) => ({
				sha: c.sha,
				message: (c.commit.message ?? "").split("\n")[0] ?? "",
				author: c.author?.login ?? c.commit.author?.name ?? null,
				date: c.commit.author?.date ?? c.commit.committer?.date ?? null,
			}));

			return { items, next_cursor };
		});
	}

	async listPullReviews(
		repo: string,
		number: number,
		params: { limit: number; page: number },
	): Promise<GithubPagedResult<GithubPullReviewItem>> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, `${repo}#${number}`, "pull_requests:read", async (octokit) => {
			const response = await octokit.rest.pulls.listReviews({
				owner,
				repo: repoName,
				pull_number: number,
				per_page: params.limit,
				page: params.page,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const next_cursor = parseNextCursorFromLink(getHeader(response.headers as Record<string, unknown>, "link"));
			const items: GithubPullReviewItem[] = response.data.map((r) => ({
				id: r.id,
				user: r.user?.login ?? null,
				state: r.state,
				submitted_at: r.submitted_at ?? null,
				body: r.body ?? null,
			}));

			return { items, next_cursor };
		});
	}

	async getIssue(repo: string, number: number): Promise<GithubIssueRead> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, `${repo}#${number}`, "issues:read", async (octokit) => {
			const { data } = await octokit.rest.issues.get({
				owner,
				repo: repoName,
				issue_number: number,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const labels = Array.isArray(data.labels)
				? data.labels
						.map((l) => (typeof l === "string" ? l : (l.name ?? "")))
						.filter((n): n is string => n.length > 0)
				: [];
			const assignees = Array.isArray(data.assignees)
				? data.assignees.map((a) => a.login).filter((login): login is string => Boolean(login))
				: [];

			return {
				number: data.number,
				title: data.title,
				state: data.state,
				state_reason: data.state_reason ?? null,
				labels,
				assignees,
				author: data.user?.login ?? null,
				is_pull_request: Boolean(data.pull_request),
				comments: data.comments,
				created_at: data.created_at,
				updated_at: data.updated_at,
				closed_at: data.closed_at ?? null,
				html_url: data.html_url,
				body: data.body ?? null,
			};
		});
	}

	async listIssueComments(
		repo: string,
		number: number,
		params: { limit: number; page: number; since?: string },
	): Promise<GithubPagedResult<GithubIssueCommentItem>> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, `${repo}#${number}`, "issues:read", async (octokit) => {
			const response = await octokit.rest.issues.listComments({
				owner,
				repo: repoName,
				issue_number: number,
				per_page: params.limit,
				page: params.page,
				since: params.since,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const next_cursor = parseNextCursorFromLink(getHeader(response.headers as Record<string, unknown>, "link"));
			const items: GithubIssueCommentItem[] = response.data.map((c) => ({
				id: c.id,
				author: c.user?.login ?? null,
				created_at: c.created_at,
				updated_at: c.updated_at,
				body: c.body ?? null,
				html_url: c.html_url,
			}));

			return { items, next_cursor };
		});
	}

	async listIssueTimeline(
		repo: string,
		number: number,
		params: { limit: number; page: number },
	): Promise<GithubPagedResult<GithubIssueTimelineItem>> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, `${repo}#${number}`, "issues:read", async (octokit) => {
			const response = await octokit.rest.issues.listEventsForTimeline({
				owner,
				repo: repoName,
				issue_number: number,
				per_page: params.limit,
				page: params.page,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const next_cursor = parseNextCursorFromLink(getHeader(response.headers as Record<string, unknown>, "link"));
			const items: GithubIssueTimelineItem[] = response.data.map((ev: any) => {
				const item: GithubIssueTimelineItem = {
					event: String(ev.event ?? "unknown"),
					actor: ev.actor?.login ?? ev.user?.login ?? null,
					created_at: ev.created_at ?? ev.submitted_at ?? null,
				};
				if (ev.label?.name) {
					item.label = String(ev.label.name);
				}
				if (ev.commit_id || ev.sha) {
					item.commit_id = String(ev.commit_id ?? ev.sha);
				}
				const sourceIssue = ev.source?.issue;
				if (sourceIssue && typeof sourceIssue.number === "number") {
					if (sourceIssue.pull_request && (ev.event === "closed" || ev.event === "connected")) {
						item.closing_pr_number = sourceIssue.number;
					} else {
						item.source_issue_number = sourceIssue.number;
					}
				}
				if (typeof ev.closing_pr_number === "number") {
					item.closing_pr_number = ev.closing_pr_number;
				}
				return item;
			});

			return { items, next_cursor };
		});
	}

	async searchIssues(
		query: string,
		params: { limit: number; page: number },
	): Promise<GithubIssueSearchResult> {
		const token = await this.resolveToken(inferRepoFromSearchQuery(query));

		return this.runWithRetry(
			token,
			"github_issue_search",
			"issues:read",
			async (octokit) => {
				const response = await octokit.rest.search.issuesAndPullRequests({
					q: query,
					per_page: params.limit,
					page: params.page,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});

				const next_cursor = parseNextCursorFromLink(getHeader(response.headers as Record<string, unknown>, "link"));
				const items: GithubIssueSearchItem[] = response.data.items.map((item: any) => ({
					repo:
						item.repository?.full_name ??
						parseRepoFromUrl(item.repository_url, item.html_url),
					number: item.number,
					title: item.title,
					state: item.state,
					is_pull_request: Boolean(item.pull_request),
					updated_at: item.updated_at,
					html_url: item.html_url,
				}));

				return {
					items,
					total_count: response.data.total_count,
					incomplete_results: Boolean(response.data.incomplete_results),
					next_cursor,
				};
			},
			{ isSearch: true },
		);
	}

	async getRepository(repo: string): Promise<GithubRepositoryRead> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, repo, "metadata:read", async (octokit) => {
			const { data } = await octokit.rest.repos.get({
				owner,
				repo: repoName,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			return {
				full_name: data.full_name,
				private: Boolean(data.private),
				default_branch: data.default_branch,
				description: data.description ?? null,
				archived: Boolean(data.archived),
				pushed_at: data.pushed_at ?? null,
				open_issues_count: data.open_issues_count,
				html_url: data.html_url,
			};
		});
	}

	async getBranch(repo: string, branch: string): Promise<GithubBranchRead> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		try {
			return await this.runWithRetry(token, `${repo}@${branch}`, "contents:read", async (octokit) => {
				const { data } = await octokit.rest.repos.getBranch({
					owner,
					repo: repoName,
					branch,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});

				return {
					exists: true,
					name: data.name,
					sha: data.commit.sha,
					protected: Boolean(data.protected),
				};
			});
		} catch (err) {
			if ((err as any)?.status === 404) {
				return { exists: false };
			}
			throw err;
		}
	}

	async getFile(repo: string, path: string, ref?: string): Promise<GithubFileRead> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const { normalizedPath, encodedPath } = encodeRepoPathSegments(path);
		if (!normalizedPath) {
			throw new Error(`Path "${path}" refers to a directory; use github_dir_list instead.`);
		}
		const token = await this.resolveToken(repo);

		return this.runWithRetry(token, `${repo}:${normalizedPath}`, "contents:read", async (octokit) => {
			const metaResp = await octokit.request(`GET /repos/{owner}/{repo}/contents/${encodedPath}`, {
				owner,
				repo: repoName,
				...(ref ? { ref } : {}),
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			if (Array.isArray(metaResp.data) || (metaResp.data as any)?.type === "dir") {
				throw new Error(`Path "${normalizedPath}" is a directory; use github_dir_list instead.`);
			}

			const meta = metaResp.data as { path?: string; sha?: string; size?: number; url?: string };
			const size = typeof meta.size === "number" ? meta.size : 0;
			const sha = String(meta.sha ?? "");
			let usedRef = ref ?? "HEAD";
			if (!ref && typeof meta.url === "string") {
				try {
					const parsedUrl = new URL(meta.url);
					const refParam = parsedUrl.searchParams.get("ref");
					if (refParam) usedRef = refParam;
				} catch {
					// keep default
				}
			}

			if (size > MAX_READABLE_FILE_BYTES) {
				return {
					path: meta.path ?? normalizedPath,
					ref: usedRef,
					sha,
					size,
					binary: true,
				};
			}

			const rawResp = await octokit.request(`GET /repos/{owner}/{repo}/contents/${encodedPath}`, {
				owner,
				repo: repoName,
				...(ref ? { ref } : {}),
				headers: {
					accept: "application/vnd.github.raw",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const text = typeof rawResp.data === "string" ? rawResp.data : String(rawResp.data ?? "");
			if (hasNullByteInFirst8KB(text)) {
				return {
					path: meta.path ?? normalizedPath,
					ref: usedRef,
					sha,
					size: size || text.length,
					binary: true,
				};
			}

			return {
				path: meta.path ?? normalizedPath,
				ref: usedRef,
				sha,
				size: size || text.length,
				binary: false,
				text,
			};
		});
	}

	async listDirectory(repo: string, path: string, ref?: string): Promise<GithubDirEntry[]> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const { normalizedPath, encodedPath } = encodeRepoPathSegments(path);
		const token = await this.resolveToken(repo);
		const route = encodedPath
			? `GET /repos/{owner}/{repo}/contents/${encodedPath}`
			: "GET /repos/{owner}/{repo}/contents";

		return this.runWithRetry(
			token,
			`${repo}:${normalizedPath || "/"}`,
			"contents:read",
			async (octokit) => {
				const resp = await octokit.request(route, {
					owner,
					repo: repoName,
					...(ref ? { ref } : {}),
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});

				if (!Array.isArray(resp.data)) {
					throw new Error(`Path "${normalizedPath}" is a file; use github_file_get instead.`);
				}

				return resp.data.map((entry: any) => ({
					name: String(entry.name ?? ""),
					path: String(entry.path ?? ""),
					type: String(entry.type ?? "file"),
					size: typeof entry.size === "number" ? entry.size : 0,
				}));
			},
		);
	}

	async listWorkflowRuns(
		repo: string,
		options: GithubListWorkflowRunsOptions,
	): Promise<GithubWorkflowRunListResult> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(
			token,
			`${repo} workflow runs`,
			"actions:read",
			async (octokit) => {
				const response = await octokit.rest.actions.listWorkflowRunsForRepo({
					owner,
					repo: repoName,
					head_sha: options.head_sha,
					branch: options.branch,
					status: options.status as any,
					per_page: options.limit,
					page: options.page,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});

				const linkHeader = getHeader(response.headers as Record<string, unknown>, "link");
				const runs = response.data.workflow_runs ?? [];
				const totalCount = response.data.total_count ?? runs.length;
				const hasMore =
					hasNextPageLink(linkHeader) ||
					(runs.length === options.limit && options.page * options.limit < totalCount);

				return {
					items: runs.map((r) => ({
						id: r.id,
						name: r.name ?? null,
						event: r.event,
						status: r.status ?? null,
						conclusion: r.conclusion ?? null,
						head_sha: r.head_sha,
						head_branch: r.head_branch ?? null,
						run_attempt: r.run_attempt ?? 1,
						created_at: r.created_at,
						html_url: r.html_url,
					})),
					next_cursor: hasMore ? String(options.page + 1) : null,
					total_count: totalCount,
				};
			},
		);
	}

	async listWorkflowRunJobs(
		repo: string,
		runId: number,
		options: GithubListWorkflowRunJobsOptions,
	): Promise<GithubWorkflowJobListResult> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);

		return this.runWithRetry(
			token,
			`${repo} workflow run #${runId} jobs`,
			"actions:read",
			async (octokit) => {
				const response = await octokit.rest.actions.listJobsForWorkflowRun({
					owner,
					repo: repoName,
					run_id: runId,
					per_page: options.limit,
					page: options.page,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});

				const linkHeader = getHeader(response.headers as Record<string, unknown>, "link");
				const jobs = response.data.jobs ?? [];
				const totalCount = response.data.total_count ?? jobs.length;
				const hasMore =
					hasNextPageLink(linkHeader) ||
					(jobs.length === options.limit && options.page * options.limit < totalCount);

				return {
					items: jobs.map((job) => ({
						id: job.id,
						name: job.name,
						status: job.status,
						conclusion: job.conclusion ?? null,
						started_at: job.started_at ?? null,
						completed_at: job.completed_at ?? null,
						steps: (job.steps ?? [])
							.filter(
								(s) =>
									s.conclusion === "failure" ||
									s.conclusion === "timed_out" ||
									s.conclusion === "cancelled",
							)
							.map((s) => ({
								name: s.name,
								number: s.number,
								conclusion: s.conclusion ?? null,
							})),
					})),
					next_cursor: hasMore ? String(options.page + 1) : null,
				};
			},
		);
	}

	async getJobLog(repo: string, jobId: number): Promise<GithubJobLogRead> {
		const { owner, repo: repoName } = this.parseRepo(repo);
		const token = await this.resolveToken(repo);
		const doFetch = this.fetchImpl ?? globalThis.fetch;

		return this.runWithRetry(
			token,
			`${repo} job #${jobId} log`,
			"actions:read",
			async () => {
				const endpointUrl = `${this.baseUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/actions/jobs/${jobId}/logs`;
				const res = await doFetch(endpointUrl, {
					method: "GET",
					redirect: "manual",
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `token ${token}`,
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});

				if (res.status === 410) {
					return { expired: true };
				}

				if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
					const signedUrl = res.headers.get("location");
					if (!signedUrl) {
						throw new GithubReadApiError(
							`GitHub returned ${res.status} without a Location header for ${repo} job #${jobId} log`,
							res.status,
						);
					}
					const logRes = await doFetch(signedUrl, {
						method: "GET",
					});
					if (logRes.status === 410) {
						return { expired: true };
					}
					if (!logRes.ok) {
						throw new GithubReadApiError(
							`Signed log download failed with status ${logRes.status} for ${repo} job #${jobId}`,
							logRes.status,
						);
					}
					const logText = await logRes.text();
					return { log: logText };
				}

				if (res.status === 200) {
					const logText = await res.text();
					return { log: logText };
				}

				let errBody = "";
				try {
					const json = (await res.json()) as { message?: string };
					errBody = json?.message ?? "";
				} catch {
					errBody = await res.text().catch(() => "");
				}
				const err = new Error(errBody || `HTTP ${res.status}`) as Error & {
					status?: number;
					response?: { headers: Record<string, string> };
				};
				err.status = res.status;
				const headersRecord: Record<string, string> = {};
				res.headers.forEach((v, k) => {
					headersRecord[k.toLowerCase()] = v;
				});
				err.response = { headers: headersRecord };
				throw err;
			},
		);
	}
}

export function createOctokitGithubReadAdapter(
	tokenResolver: GithubTokenResolver,
	options?: GithubReadAdapterOptions,
): GithubReadPort {
	return new OctokitGithubReadAdapter(tokenResolver, options);
}




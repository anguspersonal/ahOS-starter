import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { GithubIssueTimelineItem } from "../../ports/github.js";
import type { GithubReadActionDependencies } from "./prRead.js";
import {
	assertGithubReadRepoAllowed,
	loadGithubIntegrationConfig,
	matchesRepoPattern,
} from "./repoAllowlist.js";

const repoSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
	.describe("Target GitHub repository ('owner/repo').");

const issueNumberSchema = z
	.number()
	.int()
	.positive()
	.describe("Issue number.");

const limitSchema = z
	.number()
	.int()
	.min(1)
	.max(100)
	.default(30)
	.describe("Maximum number of items per page (1-100, default 30).");

const cursorSchema = z
	.string()
	.regex(/^\d+$/, "Cursor must be a positive integer page string")
	.optional()
	.describe("Page cursor returned as next_cursor from a previous call.");

function parsePageCursor(cursor: string | undefined): number {
	if (!cursor) return 1;
	const parsed = Number.parseInt(cursor, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`Invalid pagination cursor "${cursor}".`);
	}
	return parsed;
}

function normalizeIssueNotFoundError(err: unknown, repo: string, number: number): never {
	const status = (err as any)?.status;
	if (status === 404 || status === 410) {
		const message = `not found, or not visible to the read token: ${repo}#${number}`;
		const wrapped = new Error(message) as Error & { status?: number };
		wrapped.status = status;
		throw wrapped;
	}
	throw err;
}

export const githubIssueGetInputSchema = z.object({
	repo: repoSchema,
	number: issueNumberSchema,
});

export type GithubIssueGetInput = z.infer<typeof githubIssueGetInputSchema>;

export const githubIssueGetOutputSchema = z.object({
	number: z.number(),
	title: z.string(),
	state: z.string(),
	state_reason: z.string().nullable(),
	labels: z.array(z.string()),
	assignees: z.array(z.string()),
	author: z.string().nullable(),
	is_pull_request: z.boolean(),
	comments: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	closed_at: z.string().nullable(),
	html_url: z.string(),
	body: z.string().nullable(),
	body_truncated: z.boolean().optional(),
});

export type GithubIssueGetOutput = z.infer<typeof githubIssueGetOutputSchema>;

export const githubIssueCommentListInputSchema = z.object({
	repo: repoSchema,
	number: issueNumberSchema,
	limit: limitSchema,
	cursor: cursorSchema,
	since: z
		.string()
		.optional()
		.describe("Optional ISO 8601 timestamp; only comments updated at or after this time are returned."),
});

export type GithubIssueCommentListInput = z.infer<typeof githubIssueCommentListInputSchema>;

export const githubIssueCommentListOutputSchema = z.object({
	items: z.array(
		z.object({
			id: z.number(),
			author: z.string().nullable(),
			created_at: z.string(),
			updated_at: z.string(),
			body: z.string().nullable(),
			body_truncated: z.boolean().optional(),
			html_url: z.string(),
		}),
	),
	next_cursor: z.string().nullable(),
});

export type GithubIssueCommentListOutput = z.infer<typeof githubIssueCommentListOutputSchema>;

export const githubIssueTimelineInputSchema = z.object({
	repo: repoSchema,
	number: issueNumberSchema,
	limit: limitSchema,
	cursor: cursorSchema,
});

export type GithubIssueTimelineInput = z.infer<typeof githubIssueTimelineInputSchema>;

export const githubIssueTimelineOutputSchema = z.object({
	items: z.array(
		z.object({
			event: z.string(),
			actor: z.string().nullable(),
			created_at: z.string().nullable(),
			label: z.string().nullable().optional(),
			commit_id: z.string().nullable().optional(),
			source_issue_number: z.number().nullable().optional(),
			closing_pr_number: z.number().nullable().optional(),
		}),
	),
	next_cursor: z.string().nullable(),
});

export type GithubIssueTimelineOutput = z.infer<typeof githubIssueTimelineOutputSchema>;

export const githubIssueSearchInputSchema = z.object({
	query: z.string().min(1).describe("GitHub issue search query string."),
	limit: limitSchema,
	cursor: cursorSchema,
});

export type GithubIssueSearchInput = z.infer<typeof githubIssueSearchInputSchema>;

export const githubIssueSearchOutputSchema = z.object({
	items: z.array(
		z.object({
			repo: z.string(),
			number: z.number(),
			title: z.string(),
			state: z.string(),
			is_pull_request: z.boolean(),
			updated_at: z.string(),
			html_url: z.string(),
		}),
	),
	dropped: z.number(),
	total_count: z.number(),
	incomplete_results: z.boolean(),
	next_cursor: z.string().nullable(),
});

export type GithubIssueSearchOutput = z.infer<typeof githubIssueSearchOutputSchema>;

const MAX_ISSUE_BODY_CHARS = 20_000;
const MAX_COMMENT_BODY_CHARS = 4_000;
const GITHUB_SEARCH_MAX_RESULTS = 1_000;

export function createGithubIssueGetAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubIssueGetInputSchema, GithubIssueGetOutput> {
	return defineAction({
		id: "github_issue_get",
		name: "github_issue_get",
		description:
			"Read a GitHub issue's metadata and body in an allowlisted repository using the read-only GitHub token. Full notes: docs/guides/tools/github_issue_get.md",
		domain: "integrations",
		schema: githubIssueGetInputSchema,
		outputSchema: githubIssueGetOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.getIssue) {
				throw new Error("GithubReadPort.getIssue is not implemented by the configured adapter.");
			}

			let issue;
			try {
				issue = await deps.port.getIssue(input.repo, input.number);
			} catch (err) {
				normalizeIssueNotFoundError(err, input.repo, input.number);
			}

			const rawBody = issue.body ?? null;
			const bodyTruncated = rawBody !== null && rawBody.length > MAX_ISSUE_BODY_CHARS;
			const finalBody = bodyTruncated && rawBody !== null ? rawBody.slice(0, MAX_ISSUE_BODY_CHARS) : rawBody;

			const out: GithubIssueGetOutput = {
				number: issue.number,
				title: issue.title,
				state: issue.state,
				state_reason: issue.state_reason,
				labels: issue.labels,
				assignees: issue.assignees,
				author: issue.author,
				is_pull_request: issue.is_pull_request,
				comments: issue.comments,
				created_at: issue.created_at,
				updated_at: issue.updated_at,
				closed_at: issue.closed_at,
				html_url: issue.html_url,
				body: finalBody,
			};

			if (bodyTruncated) {
				out.body_truncated = true;
			}

			return out;
		},
	});
}

export function createGithubIssueCommentListAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubIssueCommentListInputSchema, GithubIssueCommentListOutput> {
	return defineAction({
		id: "github_issue_comment_list",
		name: "github_issue_comment_list",
		description:
			"List comments on a GitHub issue in an allowlisted repository with body truncation and cursor pagination.",
		domain: "integrations",
		schema: githubIssueCommentListInputSchema,
		outputSchema: githubIssueCommentListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listIssueComments) {
				throw new Error("GithubReadPort.listIssueComments is not implemented by the configured adapter.");
			}

			const limit = input.limit ?? 30;
			const page = parsePageCursor(input.cursor);

			let res;
			try {
				res = await deps.port.listIssueComments(input.repo, input.number, {
					limit,
					page,
					since: input.since,
				});
			} catch (err) {
				normalizeIssueNotFoundError(err, input.repo, input.number);
			}

			const items = res.items.map((c) => {
				const rawBody = c.body ?? null;
				const bodyTruncated = rawBody !== null && rawBody.length > MAX_COMMENT_BODY_CHARS;
				const finalBody = bodyTruncated && rawBody !== null ? rawBody.slice(0, MAX_COMMENT_BODY_CHARS) : rawBody;
				const item: GithubIssueCommentListOutput["items"][number] = {
					id: c.id,
					author: c.author,
					created_at: c.created_at,
					updated_at: c.updated_at,
					body: finalBody,
					html_url: c.html_url,
				};
				if (bodyTruncated) {
					item.body_truncated = true;
				}
				return item;
			});

			return {
				items,
				next_cursor: res.next_cursor,
			};
		},
	});
}

export function createGithubIssueTimelineAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubIssueTimelineInputSchema, GithubIssueTimelineOutput> {
	return defineAction({
		id: "github_issue_timeline",
		name: "github_issue_timeline",
		description:
			"List timeline events on a GitHub issue in an allowlisted repository, returning event identifiers without bodies.",
		domain: "integrations",
		schema: githubIssueTimelineInputSchema,
		outputSchema: githubIssueTimelineOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listIssueTimeline) {
				throw new Error("GithubReadPort.listIssueTimeline is not implemented by the configured adapter.");
			}

			const limit = input.limit ?? 30;
			const page = parsePageCursor(input.cursor);

			let res;
			try {
				res = await deps.port.listIssueTimeline(input.repo, input.number, { limit, page });
			} catch (err) {
				normalizeIssueNotFoundError(err, input.repo, input.number);
			}

			const items: GithubIssueTimelineItem[] = res.items.map((ev) => {
				const clean: GithubIssueTimelineItem = {
					event: ev.event,
					actor: ev.actor,
					created_at: ev.created_at,
				};
				if (ev.label !== undefined) clean.label = ev.label;
				if (ev.commit_id !== undefined) clean.commit_id = ev.commit_id;
				if (ev.source_issue_number !== undefined) clean.source_issue_number = ev.source_issue_number;
				if (ev.closing_pr_number !== undefined) clean.closing_pr_number = ev.closing_pr_number;
				return clean;
			});

			return {
				items,
				next_cursor: res.next_cursor,
			};
		},
	});
}

export function createGithubIssueSearchAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubIssueSearchInputSchema, GithubIssueSearchOutput> {
	return defineAction({
		id: "github_issue_search",
		name: "github_issue_search",
		description:
			"Search GitHub issues and pull requests across allowlisted repositories, dropping any off-allowlist results.",
		domain: "integrations",
		schema: githubIssueSearchInputSchema,
		outputSchema: githubIssueSearchOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			const config = await loadGithubIntegrationConfig(deps.supabase, userId);
			const allowedPatterns = [
				...(Array.isArray(config.read_repos) ? config.read_repos : []),
				...(Array.isArray(config.issue_repos) ? config.issue_repos : []),
				...(Array.isArray(config.pr_repos) ? config.pr_repos : []),
			];

			if (allowedPatterns.length === 0) {
				throw new Error(
					"No repositories are allowlisted in user_integrations (read_repos, issue_repos, or pr_repos).",
				);
			}

			if (!deps.port.searchIssues) {
				throw new Error("GithubReadPort.searchIssues is not implemented by the configured adapter.");
			}

			const limit = input.limit ?? 30;
			const page = parsePageCursor(input.cursor);
			if ((page - 1) * limit >= GITHUB_SEARCH_MAX_RESULTS) {
				throw new Error(
					`Cursor page ${page} (limit ${limit}) exceeds GitHub's search API maximum of ${GITHUB_SEARCH_MAX_RESULTS} results.`,
				);
			}

			const res = await deps.port.searchIssues(input.query, { limit, page });

			const allowedItems: GithubIssueSearchOutput["items"] = [];
			let dropped = 0;

			for (const item of res.items) {
				if (allowedPatterns.some((pattern) => matchesRepoPattern(pattern, item.repo))) {
					allowedItems.push({
						repo: item.repo,
						number: item.number,
						title: item.title,
						state: item.state,
						is_pull_request: item.is_pull_request,
						updated_at: item.updated_at,
						html_url: item.html_url,
					});
				} else {
					dropped += 1;
				}
			}

			return {
				items: allowedItems,
				dropped,
				total_count: res.total_count,
				incomplete_results: res.incomplete_results,
				next_cursor: res.next_cursor,
			};
		},
	});
}

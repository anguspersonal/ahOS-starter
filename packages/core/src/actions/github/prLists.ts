import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { assertGithubReadRepoAllowed, type GithubReadActionDependencies } from "./prRead.js";

const repoSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
	.describe("Target GitHub repository ('owner/repo').");

const prNumberSchema = z
	.number()
	.int()
	.positive()
	.describe("Pull request number.");

const limitSchema = z
	.number()
	.int()
	.min(1)
	.max(100)
	.default(30)
	.describe("Maximum number of items to return per page (1-100, default 30).");

const cursorSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "Cursor must be a positive integer page string")
	.optional()
	.describe("Opaque pagination cursor (next page number as a string).");

function parseCursorPage(cursor?: string): number {
	if (!cursor) return 1;
	const parsed = Number.parseInt(cursor, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`Invalid pagination cursor "${cursor}".`);
	}
	return parsed;
}

function normalizeNotFoundError(err: unknown, target: string): never {
	const status = (err as any)?.status;
	if (status === 404) {
		const message = `not found, or not visible to the read token: ${target}`;
		const wrapped = new Error(message) as Error & { status?: number };
		wrapped.status = 404;
		throw wrapped;
	}
	throw err;
}

const PATCH_MAX_CHARS = 5_000;
const REVIEW_BODY_MAX_CHARS = 2_000;
const GITHUB_FILES_CEILING = 3_000;
const GITHUB_COMMITS_CEILING = 250;

export const githubPrListInputSchema = z.object({
	repo: repoSchema,
	state: z
		.enum(["open", "closed", "all"])
		.default("open")
		.describe("Pull request state filter ('open', 'closed', or 'all'; default 'open')."),
	head: z
		.string()
		.min(1)
		.optional()
		.describe("Filter pulls by head user or org and branch name in 'user:ref-name' format."),
	base: z
		.string()
		.min(1)
		.optional()
		.describe("Filter pulls by base branch name."),
	limit: limitSchema,
	cursor: cursorSchema,
});

export type GithubPrListInput = z.infer<typeof githubPrListInputSchema>;

export const githubPrListItemSchema = z.object({
	number: z.number(),
	title: z.string(),
	state: z.string(),
	draft: z.boolean(),
	head_ref: z.string(),
	base_ref: z.string(),
	author: z.string().nullable(),
	updated_at: z.string(),
	html_url: z.string(),
});

export const githubPrListOutputSchema = z.object({
	items: z.array(githubPrListItemSchema),
	next_cursor: z.string().nullable(),
});

export type GithubPrListOutput = z.infer<typeof githubPrListOutputSchema>;

export const githubPrFileListInputSchema = z.object({
	repo: repoSchema,
	number: prNumberSchema,
	include_patch: z
		.boolean()
		.default(false)
		.describe("Include each file's unified diff patch (default false; capped at 5,000 characters when true)."),
	limit: limitSchema,
	cursor: cursorSchema,
});

export type GithubPrFileListInput = z.infer<typeof githubPrFileListInputSchema>;

export const githubPrFileItemSchema = z.object({
	filename: z.string(),
	status: z.string(),
	additions: z.number(),
	deletions: z.number(),
	changes: z.number(),
	previous_filename: z.string().nullable(),
	patch: z.string().optional(),
	patch_truncated: z.boolean().optional(),
});

export const githubPrFileListOutputSchema = z.object({
	items: z.array(githubPrFileItemSchema),
	next_cursor: z.string().nullable(),
	truncated: z.boolean(),
});

export type GithubPrFileListOutput = z.infer<typeof githubPrFileListOutputSchema>;

export const githubPrCommitListInputSchema = z.object({
	repo: repoSchema,
	number: prNumberSchema,
	limit: limitSchema,
	cursor: cursorSchema,
});

export type GithubPrCommitListInput = z.infer<typeof githubPrCommitListInputSchema>;

export const githubPrCommitItemSchema = z.object({
	sha: z.string(),
	message: z.string(),
	author: z.string().nullable(),
	date: z.string().nullable(),
});

export const githubPrCommitListOutputSchema = z.object({
	items: z.array(githubPrCommitItemSchema),
	next_cursor: z.string().nullable(),
	truncated: z.boolean(),
});

export type GithubPrCommitListOutput = z.infer<typeof githubPrCommitListOutputSchema>;

export const githubPrReviewListInputSchema = z.object({
	repo: repoSchema,
	number: prNumberSchema,
	limit: limitSchema,
	cursor: cursorSchema,
});

export type GithubPrReviewListInput = z.infer<typeof githubPrReviewListInputSchema>;

export const githubPrReviewItemSchema = z.object({
	id: z.number(),
	user: z.string().nullable(),
	state: z.string(),
	submitted_at: z.string().nullable(),
	body: z.string().nullable(),
	body_truncated: z.boolean().optional(),
});

export const githubPrReviewListOutputSchema = z.object({
	items: z.array(githubPrReviewItemSchema),
	next_cursor: z.string().nullable(),
});

export type GithubPrReviewListOutput = z.infer<typeof githubPrReviewListOutputSchema>;

export function createGithubPrListAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubPrListInputSchema, GithubPrListOutput> {
	return defineAction({
		id: "github_pr_list",
		name: "github_pr_list",
		description:
			"List pull requests in an allowlisted GitHub repository with explicit cursor pagination.",
		domain: "integrations",
		schema: githubPrListInputSchema,
		outputSchema: githubPrListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listPulls) {
				throw new Error("listPulls is not supported by the configured GithubReadPort");
			}

			const page = parseCursorPage(input.cursor);
			const limit = input.limit ?? 30;

			try {
				const res = await deps.port.listPulls(input.repo, {
					state: input.state ?? "open",
					head: input.head,
					base: input.base,
					limit,
					page,
				});
				return {
					items: res.items,
					next_cursor: res.next_cursor,
				};
			} catch (err) {
				normalizeNotFoundError(err, input.repo);
			}
		},
	});
}

export function createGithubPrFileListAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubPrFileListInputSchema, GithubPrFileListOutput> {
	return defineAction({
		id: "github_pr_file_list",
		name: "github_pr_file_list",
		description:
			"List changed files in a GitHub pull request with cursor pagination, optional capped patch text, and explicit ceiling truncation at 3,000 files.",
		domain: "integrations",
		schema: githubPrFileListInputSchema,
		outputSchema: githubPrFileListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listPullFiles) {
				throw new Error("listPullFiles is not supported by the configured GithubReadPort");
			}

			const page = parseCursorPage(input.cursor);
			const limit = input.limit ?? 30;
			const includePatch = input.include_patch ?? false;

			let res;
			try {
				res = await deps.port.listPullFiles(input.repo, input.number, { limit, page });
			} catch (err) {
				normalizeNotFoundError(err, `${input.repo}#${input.number}`);
			}

			const items: GithubPrFileListOutput["items"] = res.items.map((f) => {
				const base = {
					filename: f.filename,
					status: f.status,
					additions: f.additions,
					deletions: f.deletions,
					changes: f.changes,
					previous_filename: f.previous_filename,
				};
				if (!includePatch || f.patch === undefined) {
					return base;
				}
				if (f.patch.length > PATCH_MAX_CHARS) {
					return {
						...base,
						patch: f.patch.slice(0, PATCH_MAX_CHARS),
						patch_truncated: true,
					};
				}
				return {
					...base,
					patch: f.patch,
					patch_truncated: false,
				};
			});

			const totalThroughPage = (page - 1) * limit + items.length;
			const truncated =
				res.next_cursor === null &&
				(items.length >= GITHUB_FILES_CEILING || (items.length === limit && totalThroughPage >= GITHUB_FILES_CEILING));

			return {
				items,
				next_cursor: res.next_cursor,
				truncated,
			};
		},
	});
}

export function createGithubPrCommitListAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubPrCommitListInputSchema, GithubPrCommitListOutput> {
	return defineAction({
		id: "github_pr_commit_list",
		name: "github_pr_commit_list",
		description:
			"List commits on a GitHub pull request with cursor pagination and explicit ceiling truncation at 250 commits.",
		domain: "integrations",
		schema: githubPrCommitListInputSchema,
		outputSchema: githubPrCommitListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listPullCommits) {
				throw new Error("listPullCommits is not supported by the configured GithubReadPort");
			}

			const page = parseCursorPage(input.cursor);
			const limit = input.limit ?? 30;

			let res;
			try {
				res = await deps.port.listPullCommits(input.repo, input.number, { limit, page });
			} catch (err) {
				normalizeNotFoundError(err, `${input.repo}#${input.number}`);
			}

			const totalThroughPage = (page - 1) * limit + res.items.length;
			const truncated =
				res.next_cursor === null &&
				(res.items.length >= GITHUB_COMMITS_CEILING ||
					(res.items.length > 0 && totalThroughPage >= GITHUB_COMMITS_CEILING));

			return {
				items: res.items,
				next_cursor: res.next_cursor,
				truncated,
			};
		},
	});
}

export function createGithubPrReviewListAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubPrReviewListInputSchema, GithubPrReviewListOutput> {
	return defineAction({
		id: "github_pr_review_list",
		name: "github_pr_review_list",
		description:
			"List reviews on a GitHub pull request with cursor pagination and 2,000-character review body capping.",
		domain: "integrations",
		schema: githubPrReviewListInputSchema,
		outputSchema: githubPrReviewListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listPullReviews) {
				throw new Error("listPullReviews is not supported by the configured GithubReadPort");
			}

			const page = parseCursorPage(input.cursor);
			const limit = input.limit ?? 30;

			let res;
			try {
				res = await deps.port.listPullReviews(input.repo, input.number, { limit, page });
			} catch (err) {
				normalizeNotFoundError(err, `${input.repo}#${input.number}`);
			}

			const items: GithubPrReviewListOutput["items"] = res.items.map((r) => {
				const rawBody = r.body ?? null;
				if (rawBody !== null && rawBody.length > REVIEW_BODY_MAX_CHARS) {
					return {
						id: r.id,
						user: r.user,
						state: r.state,
						submitted_at: r.submitted_at,
						body: rawBody.slice(0, REVIEW_BODY_MAX_CHARS),
						body_truncated: true,
					};
				}
				return {
					id: r.id,
					user: r.user,
					state: r.state,
					submitted_at: r.submitted_at,
					body: rawBody,
				};
			});

			return {
				items,
				next_cursor: res.next_cursor,
			};
		},
	});
}

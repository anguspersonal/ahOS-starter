import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { GithubReadPort } from "../../ports/github.js";
import type { GenericSupabaseClient } from "./issueCreate.js";
import { assertGithubReadRepoAllowed } from "./repoAllowlist.js";
export * from "./repoAllowlist.js";

const repoSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
	.describe("Target GitHub repository ('owner/repo').");

const prNumberSchema = z
	.number()
	.int()
	.positive()
	.describe("Pull request number.");

export const githubPrGetInputSchema = z.object({
	repo: repoSchema,
	number: prNumberSchema,
	max_body_chars: z
		.number()
		.int()
		.positive()
		.max(500_000)
		.default(20_000)
		.describe("Maximum number of characters of the pull request body to return (default 20,000)."),
});

export type GithubPrGetInput = z.infer<typeof githubPrGetInputSchema>;

export const githubPrGetOutputSchema = z.object({
	number: z.number(),
	title: z.string(),
	state: z.string(),
	draft: z.boolean(),
	merged: z.boolean(),
	head: z.object({
		ref: z.string(),
		sha: z.string(),
	}),
	base: z.object({
		ref: z.string(),
		sha: z.string(),
	}),
	author: z.string().nullable(),
	html_url: z.string(),
	additions: z.number(),
	deletions: z.number(),
	changed_files: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	body: z.string().nullable(),
	body_truncated: z.boolean().optional(),
	body_chars: z.number().optional(),
});

export type GithubPrGetOutput = z.infer<typeof githubPrGetOutputSchema>;

export const githubPrDiffInputSchema = z.object({
	repo: repoSchema,
	number: prNumberSchema,
	max_chars: z
		.number()
		.int()
		.positive()
		.max(500_000)
		.default(100_000)
		.describe("Maximum number of characters of the unified diff to return (default 100,000, max 500,000)."),
});

export type GithubPrDiffInput = z.infer<typeof githubPrDiffInputSchema>;

export const githubPrDiffOutputSchema = z.object({
	diff: z.string(),
	truncated: z.boolean(),
	total_chars: z.number(),
});

export type GithubPrDiffOutput = z.infer<typeof githubPrDiffOutputSchema>;

export const githubPrMergeabilityInputSchema = z.object({
	repo: repoSchema,
	number: prNumberSchema,
});

export type GithubPrMergeabilityInput = z.infer<typeof githubPrMergeabilityInputSchema>;

export const githubPrMergeabilityOutputSchema = z.object({
	mergeable: z.boolean().nullable(),
	mergeable_state: z.string().nullable(),
	head_ref: z.string(),
	base_ref: z.string(),
	computed: z.boolean(),
});

export type GithubPrMergeabilityOutput = z.infer<typeof githubPrMergeabilityOutputSchema>;

export interface GithubReadActionDependencies {
	port: GithubReadPort;
	supabase: GenericSupabaseClient;
	getUserId?: () => string;
	sleep?: (ms: number) => Promise<void>;
}

function normalizeNotFoundError(err: unknown, repo: string, number: number): never {
	const status = (err as any)?.status;
	if (status === 404) {
		const message = `not found, or not visible to the read token: ${repo}#${number}`;
		const wrapped = new Error(message) as Error & { status?: number };
		wrapped.status = 404;
		throw wrapped;
	}
	throw err;
}

export function createGithubPrGetAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubPrGetInputSchema, GithubPrGetOutput> {
	return defineAction({
		id: "github_pr_get",
		name: "github_pr_get",
		description:
			"Read a GitHub pull request's metadata and body in an allowlisted repository using the read-only GitHub token. Full notes: docs/guides/tools/github_pr_get.md",
		domain: "integrations",
		schema: githubPrGetInputSchema,
		outputSchema: githubPrGetOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			let pr;
			try {
				pr = await deps.port.getPull(input.repo, input.number);
			} catch (err) {
				normalizeNotFoundError(err, input.repo, input.number);
			}

			const maxBody = input.max_body_chars ?? 20_000;
			const rawBody = pr.body ?? null;
			const bodyTruncated = rawBody !== null && rawBody.length > maxBody;
			const finalBody = bodyTruncated && rawBody !== null ? rawBody.slice(0, maxBody) : rawBody;

			const out: GithubPrGetOutput = {
				number: pr.number,
				title: pr.title,
				state: pr.state,
				draft: pr.draft,
				merged: pr.merged,
				head: pr.head,
				base: pr.base,
				author: pr.author,
				html_url: pr.html_url,
				additions: pr.additions,
				deletions: pr.deletions,
				changed_files: pr.changed_files,
				created_at: pr.created_at,
				updated_at: pr.updated_at,
				body: finalBody,
			};

			if (bodyTruncated && rawBody !== null) {
				out.body_truncated = true;
				out.body_chars = rawBody.length;
			}

			return out;
		},
	});
}

export function createGithubPrDiffAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubPrDiffInputSchema, GithubPrDiffOutput> {
	return defineAction({
		id: "github_pr_diff",
		name: "github_pr_diff",
		description:
			"Read a GitHub pull request's unified diff in an allowlisted repository using the read-only GitHub token, with explicit truncation bounds.",
		domain: "integrations",
		schema: githubPrDiffInputSchema,
		outputSchema: githubPrDiffOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			let rawDiff: string;
			try {
				rawDiff = await deps.port.getPullDiff(input.repo, input.number);
			} catch (err) {
				normalizeNotFoundError(err, input.repo, input.number);
			}

			const maxChars = input.max_chars ?? 100_000;
			const totalChars = rawDiff.length;
			const truncated = totalChars > maxChars;
			const diff = truncated ? rawDiff.slice(0, maxChars) : rawDiff;

			return {
				diff,
				truncated,
				total_chars: totalChars,
			};
		},
	});
}

export function createGithubPrMergeabilityAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubPrMergeabilityInputSchema, GithubPrMergeabilityOutput> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

	return defineAction({
		id: "github_pr_mergeability",
		name: "github_pr_mergeability",
		description:
			"Read a GitHub pull request's mergeability state in an allowlisted repository using the read-only GitHub token, re-reading once if GitHub has not computed it yet.",
		domain: "integrations",
		schema: githubPrMergeabilityInputSchema,
		outputSchema: githubPrMergeabilityOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			let pr;
			try {
				pr = await deps.port.getPull(input.repo, input.number);
				if (pr.mergeable === null) {
					await sleep(2000);
					pr = await deps.port.getPull(input.repo, input.number);
				}
			} catch (err) {
				normalizeNotFoundError(err, input.repo, input.number);
			}

			const computed = pr.mergeable !== null;
			return {
				mergeable: pr.mergeable,
				mergeable_state: pr.mergeable_state,
				head_ref: pr.head.ref,
				base_ref: pr.base.ref,
				computed,
			};
		},
	});
}

import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { GithubPullsPort, GithubReadPort } from "../../ports/github.js";
import type { GenericSupabaseClient } from "./issueCreate.js";
import { assertGithubPrRepoAllowed, type GithubPullsActionDependencies } from "./prWrite.js";

export const SELF_REVIEW_ERROR_MESSAGE =
	"GitHub does not let the PR's author approve or request changes on it";

const repoSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
	.describe("Target GitHub repository ('owner/repo').");
const prNumberSchema = z.number().int().positive().describe("Pull request number.");
const bodySchema = z.string().max(60000, "Body must be at most 60,000 characters").optional();

export interface GithubReviewActionDependencies extends GithubPullsActionDependencies {
	readPort?: Pick<GithubReadPort, "getRepository">;
}

function resolveDeps(
	portOrDeps: GithubPullsPort | GithubReviewActionDependencies,
	options?: {
		supabase: GenericSupabaseClient;
		getUserId?: () => string;
		readPort?: Pick<GithubReadPort, "getRepository">;
	},
): GithubReviewActionDependencies {
	return "port" in portOrDeps
		? portOrDeps
		: {
				port: portOrDeps,
				readPort: options?.readPort,
				supabase: options!.supabase,
				getUserId: options?.getUserId,
			};
}

export const githubReviewCreateInputSchema = z
	.object({
		repo: repoSchema,
		number: prNumberSchema,
		event: z
			.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"])
			.default("COMMENT")
			.optional()
			.describe("Review verdict ('COMMENT', 'APPROVE', or 'REQUEST_CHANGES'; defaults to 'COMMENT')."),
		body: bodySchema.describe(
			"Markdown review body (up to 60,000 characters; required unless event is 'APPROVE').",
		),
	})
	.refine(
		(v) => (v.event ?? "COMMENT") === "APPROVE" || (typeof v.body === "string" && v.body.trim().length > 0),
		{
			message: "Body is required unless event is APPROVE",
			path: ["body"],
		},
	);
export type GithubReviewCreateInput = z.infer<typeof githubReviewCreateInputSchema>;

export const githubReviewCreateOutputSchema = z.object({
	id: z.number(),
	html_url: z.string(),
	state: z.string(),
});
export type GithubReviewCreateOutput = z.infer<typeof githubReviewCreateOutputSchema>;

export const githubBranchDeleteInputSchema = z.object({
	repo: repoSchema,
	branch: z.string().min(1, "Branch name must not be empty").describe("Branch name to delete."),
	force_open_pr: z
		.boolean()
		.default(false)
		.optional()
		.describe("When true, delete the branch even if an open pull request uses it as head."),
});
export type GithubBranchDeleteInput = z.infer<typeof githubBranchDeleteInputSchema>;

export const githubBranchDeleteOutputSchema = z.object({
	deleted: z.boolean(),
});
export type GithubBranchDeleteOutput = z.infer<typeof githubBranchDeleteOutputSchema>;

export function createGithubReviewCreateAction(
	portOrDeps: GithubPullsPort | GithubReviewActionDependencies,
	options?: {
		supabase: GenericSupabaseClient;
		getUserId?: () => string;
		readPort?: Pick<GithubReadPort, "getRepository">;
	},
): ActionDefinition<typeof githubReviewCreateInputSchema, GithubReviewCreateOutput> {
	const deps = resolveDeps(portOrDeps, options);
	return defineAction({
		id: "github_review_create",
		name: "github_review_create",
		description:
			"Post a review on a GitHub pull request in an allowlisted pr_repos repository, gated by owner approval.",
		domain: "integrations",
		schema: githubReviewCreateInputSchema,
		outputSchema: githubReviewCreateOutputSchema,
		needsApproval: true,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async run(input, context) {
			const targetRepo = await assertGithubPrRepoAllowed(
				deps.supabase,
				context.userId ?? deps.getUserId?.(),
				input.repo,
			);
			const event = input.event ?? "COMMENT";
			const createReviewFn = deps.port.createReview ?? deps.port.createPullRequestReview;
			if (!createReviewFn) {
				throw new Error("GithubPullsPort.createReview is not implemented by the configured adapter.");
			}
			try {
				const review = await createReviewFn.call(deps.port, targetRepo, input.number, {
					event,
					...(input.body !== undefined ? { body: input.body } : {}),
				});
				return { id: review.id, html_url: review.html_url, state: review.state };
			} catch (err) {
				const status = (err as { status?: number })?.status;
				if (status === 422 && (event === "APPROVE" || event === "REQUEST_CHANGES")) {
					throw new Error(SELF_REVIEW_ERROR_MESSAGE);
				}
				throw err;
			}
		},
	});
}

export function createGithubBranchDeleteAction(
	portOrDeps: GithubPullsPort | GithubReviewActionDependencies,
	options?: {
		supabase: GenericSupabaseClient;
		getUserId?: () => string;
		readPort?: Pick<GithubReadPort, "getRepository">;
	},
): ActionDefinition<typeof githubBranchDeleteInputSchema, GithubBranchDeleteOutput> {
	const deps = resolveDeps(portOrDeps, options);
	return defineAction({
		id: "github_branch_delete",
		name: "github_branch_delete",
		description:
			"Delete a non-default GitHub branch in an allowlisted pr_repos repository, gated by owner approval.",
		domain: "integrations",
		schema: githubBranchDeleteInputSchema,
		outputSchema: githubBranchDeleteOutputSchema,
		needsApproval: true,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		async run(input, context) {
			const targetRepo = await assertGithubPrRepoAllowed(
				deps.supabase,
				context.userId ?? deps.getUserId?.(),
				input.repo,
			);
			const branch = input.branch.replace(/^refs\/heads\//, "").replace(/^heads\//, "").trim();
			const getRepo = deps.readPort?.getRepository
				? () => deps.readPort!.getRepository!(targetRepo)
				: deps.port.getRepository
					? () => deps.port.getRepository!(targetRepo)
					: undefined;
			if (!getRepo) {
				throw new Error("GithubReadPort.getRepository is not implemented by the configured adapter.");
			}
			const repoInfo = await getRepo();
			const defaultBranch = repoInfo.default_branch;
			if (branch === defaultBranch) {
				throw new Error(`Cannot delete the repository's default branch "${defaultBranch}" in ${targetRepo}.`);
			}
			if (!input.force_open_pr) {
				if (!deps.port.listOpenPullsFromHead) {
					throw new Error("GithubPullsPort.listOpenPullsFromHead is not implemented by the configured adapter.");
				}
				const openPulls = await deps.port.listOpenPullsFromHead(targetRepo, branch);
				if (openPulls.length > 0) {
					throw new Error(
						`Cannot delete branch "${branch}" in ${targetRepo}: open pull request #${openPulls[0].number} uses it as head (set force_open_pr: true to override).`,
					);
				}
			}
			if (!deps.port.deleteBranch) {
				throw new Error("GithubPullsPort.deleteBranch is not implemented by the configured adapter.");
			}
			try {
				const result = await deps.port.deleteBranch(targetRepo, branch);
				return { deleted: Boolean(result.deleted) };
			} catch (err) {
				const status = (err as { status?: number })?.status;
				const msg = err instanceof Error ? err.message : String(err);
				if (status === 422 && /reference does not exist/i.test(msg)) {
					return { deleted: false };
				}
				if (status === 422) {
					throw new Error(`Cannot delete branch "${branch}" in ${targetRepo} (protected branch): ${msg}`);
				}
				throw err;
			}
		},
	});
}

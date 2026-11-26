import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { GithubIssuesPort } from "../../ports/github.js";
import type { GenericSupabaseClient, GithubIssueActionDependencies } from "./issueCreate.js";
import { assertGithubIssueRepoAllowed } from "./repoAllowlist.js";

const repoSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
	.describe("Target GitHub repository ('owner/repo').");

const issueNumberSchema = z
	.number()
	.int()
	.positive()
	.describe("Issue or pull request number.");

function resolveDeps(
	portOrDeps: GithubIssuesPort | GithubIssueActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): GithubIssueActionDependencies {
	return "port" in portOrDeps
		? portOrDeps
		: {
				port: portOrDeps,
				supabase: options!.supabase,
				getUserId: options?.getUserId,
			};
}

export const githubCommentCreateInputSchema = z.object({
	repo: repoSchema,
	number: issueNumberSchema,
	body: z
		.string()
		.min(1, "Body must not be empty")
		.max(60000, "Body must be at most 60,000 characters")
		.describe("The markdown comment body (1-60,000 characters)."),
});

export type GithubCommentCreateInput = z.infer<typeof githubCommentCreateInputSchema>;

export const githubCommentCreateOutputSchema = z.object({
	id: z.number(),
	html_url: z.string(),
});

export type GithubCommentCreateOutput = z.infer<typeof githubCommentCreateOutputSchema>;

export const githubLabelAddInputSchema = z.object({
	repo: repoSchema,
	number: issueNumberSchema,
	labels: z
		.array(z.string().min(1))
		.min(1, "At least 1 label is required")
		.max(10, "At most 10 labels allowed")
		.describe("Labels to add to the issue or pull request (1-10 non-empty strings)."),
});

export type GithubLabelAddInput = z.infer<typeof githubLabelAddInputSchema>;

export const githubLabelAddOutputSchema = z.object({
	labels: z.array(z.string()),
});

export type GithubLabelAddOutput = z.infer<typeof githubLabelAddOutputSchema>;

export const githubLabelRemoveInputSchema = z.object({
	repo: repoSchema,
	number: issueNumberSchema,
	label: z.string().min(1, "Label must not be empty").describe("Label name to remove."),
});

export type GithubLabelRemoveInput = z.infer<typeof githubLabelRemoveInputSchema>;

export const githubLabelRemoveOutputSchema = z.object({
	removed: z.boolean(),
});

export type GithubLabelRemoveOutput = z.infer<typeof githubLabelRemoveOutputSchema>;

export function createGithubCommentCreateAction(
	portOrDeps: GithubIssuesPort | GithubIssueActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): ActionDefinition<typeof githubCommentCreateInputSchema, GithubCommentCreateOutput> {
	const deps = resolveDeps(portOrDeps, options);

	return defineAction({
		id: "github_comment_create",
		name: "github_comment_create",
		description:
			"Post a comment on a GitHub issue or pull request in an allowlisted issue_repos repository, gated by owner approval. Full notes: docs/guides/tools/github_comment_create.md",
		domain: "integrations",
		schema: githubCommentCreateInputSchema,
		outputSchema: githubCommentCreateOutputSchema,
		needsApproval: true,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			const targetRepo = await assertGithubIssueRepoAllowed(deps.supabase, userId, input.repo);
			if (!deps.port.createComment) {
				throw new Error("GithubIssuesPort.createComment is not implemented by the configured adapter.");
			}
			const caller = context.caller ?? "unknown";
			const finalBody = `${input.body.trim()}\n\n_Posted via ahOS (${caller})_`;
			const comment = await deps.port.createComment(targetRepo, input.number, finalBody);
			return {
				id: comment.id,
				html_url: comment.html_url,
			};
		},
	});
}

export function createGithubLabelAddAction(
	portOrDeps: GithubIssuesPort | GithubIssueActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): ActionDefinition<typeof githubLabelAddInputSchema, GithubLabelAddOutput> {
	const deps = resolveDeps(portOrDeps, options);

	return defineAction({
		id: "github_label_add",
		name: "github_label_add",
		description:
			"Add one to ten labels to a GitHub issue or pull request in an allowlisted issue_repos repository, gated by owner approval.",
		domain: "integrations",
		schema: githubLabelAddInputSchema,
		outputSchema: githubLabelAddOutputSchema,
		needsApproval: true,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			const targetRepo = await assertGithubIssueRepoAllowed(deps.supabase, userId, input.repo);
			if (!deps.port.addLabels) {
				throw new Error("GithubIssuesPort.addLabels is not implemented by the configured adapter.");
			}
			const res = await deps.port.addLabels(targetRepo, input.number, input.labels);
			return { labels: res.labels };
		},
	});
}

export function createGithubLabelRemoveAction(
	portOrDeps: GithubIssuesPort | GithubIssueActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): ActionDefinition<typeof githubLabelRemoveInputSchema, GithubLabelRemoveOutput> {
	const deps = resolveDeps(portOrDeps, options);

	return defineAction({
		id: "github_label_remove",
		name: "github_label_remove",
		description:
			"Remove a label from a GitHub issue or pull request in an allowlisted issue_repos repository, gated by owner approval.",
		domain: "integrations",
		schema: githubLabelRemoveInputSchema,
		outputSchema: githubLabelRemoveOutputSchema,
		needsApproval: true,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			const targetRepo = await assertGithubIssueRepoAllowed(deps.supabase, userId, input.repo);
			if (!deps.port.removeLabel) {
				throw new Error("GithubIssuesPort.removeLabel is not implemented by the configured adapter.");
			}
			const res = await deps.port.removeLabel(targetRepo, input.number, input.label);
			return { removed: res.removed };
		},
	});
}

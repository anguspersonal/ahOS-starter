import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { GithubPullsPort } from "../../ports/github.js";
import type { GenericSupabaseClient } from "./issueCreate.js";
import { loadGithubIntegrationConfig, matchesRepoPattern } from "./repoAllowlist.js";

const repoSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
	.describe("Target GitHub repository ('owner/repo').");
const prNumberSchema = z.number().int().positive().describe("Pull request number.");
const titleSchema = z
	.string()
	.min(1, "Title must not be empty")
	.max(256, "Title must be at most 256 characters");
const bodySchema = z.string().max(60000, "Body must be at most 60,000 characters").optional();

export interface GithubPullsActionDependencies {
	port: GithubPullsPort;
	supabase: GenericSupabaseClient;
	getUserId?: () => string;
}

function resolveDeps(
	portOrDeps: GithubPullsPort | GithubPullsActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): GithubPullsActionDependencies {
	return "port" in portOrDeps
		? portOrDeps
		: { port: portOrDeps, supabase: options!.supabase, getUserId: options?.getUserId };
}

export async function assertGithubPrRepoAllowed(
	supabase: GenericSupabaseClient,
	userId: string | undefined,
	repo: string,
): Promise<string> {
	const config = await loadGithubIntegrationConfig(supabase, userId);
	const prRepos = Array.isArray(config.pr_repos) ? config.pr_repos : [];
	if (prRepos.length === 0) {
		throw new Error(
			"No pr_repos configured for GitHub integration in user_integrations. Use integration_set to configure pr_repos.",
		);
	}
	if (!prRepos.some((pattern) => matchesRepoPattern(pattern, repo))) {
		throw new Error(`Repository "${repo}" is not in the allowed pr_repos: ${prRepos.join(", ")}.`);
	}
	return repo;
}

export const githubPrCreateInputSchema = z.object({
	repo: repoSchema,
	title: titleSchema.describe("The pull request title (1-256 characters)."),
	head: z.string().min(1, "Head branch must not be empty").describe("Head branch name."),
	base: z.string().min(1, "Base branch must not be empty").describe("Base branch name."),
	body: bodySchema.describe("The pull request markdown body (up to 60,000 characters)."),
	draft: z.boolean().default(true).optional().describe("Whether to open the pull request as a draft (defaults to true)."),
});
export type GithubPrCreateInput = z.infer<typeof githubPrCreateInputSchema>;

export const githubPrCreateOutputSchema = z.object({
	number: z.number(),
	html_url: z.string(),
	head_sha: z.string(),
	created: z.boolean(),
});
export type GithubPrCreateOutput = z.infer<typeof githubPrCreateOutputSchema>;

export const githubPrUpdateInputSchema = z
	.object({
		repo: repoSchema,
		number: prNumberSchema,
		title: titleSchema.optional().describe("New pull request title (1-256 characters)."),
		body: bodySchema.describe("New pull request markdown body (up to 60,000 characters)."),
	})
	.refine((v) => v.title !== undefined || v.body !== undefined, {
		message: "At least one of title or body must be provided",
	});
export type GithubPrUpdateInput = z.infer<typeof githubPrUpdateInputSchema>;

export const githubPrUpdateOutputSchema = z.object({
	number: z.number(),
	title: z.string(),
	state: z.string(),
	html_url: z.string(),
});
export type GithubPrUpdateOutput = z.infer<typeof githubPrUpdateOutputSchema>;

export const githubPrCloseInputSchema = z.object({ repo: repoSchema, number: prNumberSchema });
export type GithubPrCloseInput = z.infer<typeof githubPrCloseInputSchema>;

export const githubPrCloseOutputSchema = z.object({ number: z.number(), state: z.string() });
export type GithubPrCloseOutput = z.infer<typeof githubPrCloseOutputSchema>;

export function createGithubPrCreateAction(
	portOrDeps: GithubPullsPort | GithubPullsActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): ActionDefinition<typeof githubPrCreateInputSchema, GithubPrCreateOutput> {
	const deps = resolveDeps(portOrDeps, options);
	return defineAction({
		id: "github_pr_create",
		name: "github_pr_create",
		description:
			"Open a GitHub pull request (draft by default) in an allowlisted pr_repos repository, gated by owner approval. Full notes: docs/guides/tools/github_pr_create.md",
		domain: "integrations",
		schema: githubPrCreateInputSchema,
		outputSchema: githubPrCreateOutputSchema,
		needsApproval: true,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async run(input, context) {
			const targetRepo = await assertGithubPrRepoAllowed(deps.supabase, context.userId ?? deps.getUserId?.(), input.repo);
			const existing = await deps.port.findOpenPull(targetRepo, input.head, input.base);
			if (existing) return { ...existing, created: false };
			const caller = context.caller ?? "unknown";
			const footer = `_Created via ahOS (${caller})_`;
			const body = input.body ? `${input.body.trim()}\n\n${footer}` : footer;
			const pr = await deps.port.createPull(targetRepo, {
				title: input.title,
				head: input.head,
				base: input.base,
				body,
				draft: input.draft ?? true,
			});
			return { ...pr, created: true };
		},
	});
}

export function createGithubPrUpdateAction(
	portOrDeps: GithubPullsPort | GithubPullsActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): ActionDefinition<typeof githubPrUpdateInputSchema, GithubPrUpdateOutput> {
	const deps = resolveDeps(portOrDeps, options);
	return defineAction({
		id: "github_pr_update",
		name: "github_pr_update",
		description: "Update the title or body of a GitHub pull request in an allowlisted pr_repos repository, gated by owner approval.",
		domain: "integrations",
		schema: githubPrUpdateInputSchema,
		outputSchema: githubPrUpdateOutputSchema,
		needsApproval: true,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async run(input, context) {
			const targetRepo = await assertGithubPrRepoAllowed(deps.supabase, context.userId ?? deps.getUserId?.(), input.repo);
			return deps.port.updatePull(targetRepo, input.number, { title: input.title, body: input.body });
		},
	});
}

export function createGithubPrCloseAction(
	portOrDeps: GithubPullsPort | GithubPullsActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): ActionDefinition<typeof githubPrCloseInputSchema, GithubPrCloseOutput> {
	const deps = resolveDeps(portOrDeps, options);
	return defineAction({
		id: "github_pr_close",
		name: "github_pr_close",
		description: "Close a GitHub pull request without merging in an allowlisted pr_repos repository, gated by owner approval.",
		domain: "integrations",
		schema: githubPrCloseInputSchema,
		outputSchema: githubPrCloseOutputSchema,
		needsApproval: true,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async run(input, context) {
			const targetRepo = await assertGithubPrRepoAllowed(deps.supabase, context.userId ?? deps.getUserId?.(), input.repo);
			return deps.port.closePull(targetRepo, input.number);
		},
	});
}

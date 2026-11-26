import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import type { GithubIssuesPort } from "../../ports/github.js";
import { assertGithubIssueRepoAllowed } from "./repoAllowlist.js";

export const githubIssueCreateInputSchema = z.object({
	repo: z
		.string()
		.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
		.optional()
		.describe("Target GitHub repository ('owner/repo'). When omitted, defaults to config.default_repo."),
	title: z
		.string()
		.min(1, "Title must not be empty")
		.max(256, "Title must be at most 256 characters")
		.describe("The issue title."),
	body: z
		.string()
		.max(60000, "Body must be at most 60,000 characters")
		.optional()
		.describe("The issue markdown body."),
	labels: z
		.array(z.string())
		.max(10, "At most 10 labels allowed")
		.optional()
		.describe("Labels to apply to the issue. Labels that do not exist in the repo are left to GitHub."),
});

export type GithubIssueCreateInput = z.infer<typeof githubIssueCreateInputSchema>;

export const githubIssueCreateOutputSchema = z.object({
	number: z.number(),
	url: z.string(),
	repo: z.string(),
	created: z.boolean(),
});

export type GithubIssueCreateOutput = z.infer<typeof githubIssueCreateOutputSchema>;

export interface GenericSupabaseClient {
	from(table: string): any;
}

export interface GithubIntegrationConfig {
	issue_repos?: string[];
	default_repo?: string;
}

export interface GithubIssueActionDependencies {
	port: GithubIssuesPort;
	supabase: GenericSupabaseClient;
	getUserId?: () => string;
}

export async function executeGithubIssueCreate(
	input: GithubIssueCreateInput,
	context: ActionContext,
	deps: GithubIssueActionDependencies,
): Promise<GithubIssueCreateOutput> {
	const userId = context.userId ?? deps.getUserId?.();
	const targetRepo = await assertGithubIssueRepoAllowed(deps.supabase, userId, input.repo);

	// Duplicate guard: return existing open issue if matching exact title
	const existing = await deps.port.findOpenIssueByTitle(targetRepo, input.title);
	if (existing) {
		return {
			number: existing.number,
			url: existing.url,
			repo: targetRepo,
			created: false,
		};
	}

	// Append provenance footer
	const caller = context.caller ?? "unknown";
	const footer = `\n\n_Created via ahOS (${caller})_`;
	const finalBody = input.body ? `${input.body.trim()}${footer}` : `_Created via ahOS (${caller})_`;

	const issue = await deps.port.createIssue(targetRepo, {
		title: input.title,
		body: finalBody,
		labels: input.labels,
	});

	// Record audit row in system_decisions
	const { error: decisionError } = await deps.supabase.from("system_decisions").insert({
		user_id: userId,
		decision_type: "github_issue_created",
		stage: "action",
		status: "resolved",
		user_visible: true,
		requires_user_action: false,
		payload: {
			repo: targetRepo,
			number: issue.number,
			url: issue.url,
			title: input.title,
			labels: input.labels ?? [],
		},
	});

	if (decisionError) {
		console.error(`[github_issue_create] system_decisions audit failed: ${decisionError.message}`);
	}

	return {
		number: issue.number,
		url: issue.url,
		repo: targetRepo,
		created: true,
	};
}

export function createGithubIssueAction(
	portOrDeps: GithubIssuesPort | GithubIssueActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): ActionDefinition<typeof githubIssueCreateInputSchema, GithubIssueCreateOutput> {
	const deps: GithubIssueActionDependencies =
		"port" in portOrDeps
			? portOrDeps
			: {
					port: portOrDeps,
					supabase: options!.supabase,
					getUserId: options?.getUserId,
				};

	return defineAction({
		id: "github_issue_create",
		name: "github_issue_create",
		description:
			"Create a GitHub issue in an allowlisted repository, or return an existing open issue with the exact same title.",
		domain: "integrations",
		schema: githubIssueCreateInputSchema,
		outputSchema: githubIssueCreateOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp(result) {
			if (result.created) {
				return `Created issue #${result.number} in ${result.repo}: ${result.url}`;
			}
			return `Found existing open issue #${result.number} in ${result.repo}: ${result.url}`;
		},
		async run(input, context) {
			return executeGithubIssueCreate(input, context, deps);
		},
	});
}

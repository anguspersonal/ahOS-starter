import {
	createGithubIssueAction,
	githubIssueCreateInputSchema,
	type GenericSupabaseClient,
	type GithubIssuesPort,
} from "@ahkms/core";
import { createOctokitGithubIssuesAdapter } from "@ahkms/core/adapters";
import { getGithubCredential } from "../credentials.js";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { toMcpTool } from "../actions/adapters/mcp.js";

export const githubIssueCreateInput = githubIssueCreateInputSchema.shape;

export function createGithubIssueCreateActionWithDeps(
	port?: GithubIssuesPort,
	customSupabase?: GenericSupabaseClient,
	customGetUserId?: () => string,
) {
	const resolvedPort =
		port ??
		createOctokitGithubIssuesAdapter(async (repo) => {
			return getGithubCredential("github_issues", repo);
		});

	return createGithubIssueAction({
		port: resolvedPort,
		supabase: customSupabase ?? (supabase as unknown as GenericSupabaseClient),
		getUserId: customGetUserId ?? getCurrentUserId,
	});
}

export const githubIssueCreateAction = createGithubIssueCreateActionWithDeps();

export async function githubIssueCreateHandler(args: unknown) {
	return toMcpTool(githubIssueCreateAction).handler(args);
}

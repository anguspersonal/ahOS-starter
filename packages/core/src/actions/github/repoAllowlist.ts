import type { GenericSupabaseClient } from "./issueCreate.js";

export interface GithubReadIntegrationConfig {
	read_repos?: string[];
	issue_repos?: string[];
	pr_repos?: string[];
	default_repo?: string;
}

export function matchesRepoPattern(pattern: string, repo: string): boolean {
	const normalizedPattern = pattern.toLowerCase();
	const normalizedRepo = repo.toLowerCase();
	if (normalizedPattern === normalizedRepo) return true;
	if (normalizedPattern.endsWith("/*")) {
		const prefix = normalizedPattern.slice(0, -1);
		return (
			normalizedRepo.startsWith(prefix) &&
			normalizedRepo.length > prefix.length &&
			!normalizedRepo.slice(prefix.length).includes("/")
		);
	}
	return false;
}

export async function loadGithubIntegrationConfig(
	supabase: GenericSupabaseClient,
	userId: string | undefined,
): Promise<GithubReadIntegrationConfig> {
	if (!userId) {
		throw new Error("Missing user context: userId is required to verify integration permissions.");
	}

	const { data, error } = await supabase
		.from("user_integrations")
		.select("config, enabled")
		.eq("user_id", userId)
		.eq("provider", "github")
		.maybeSingle();

	if (error) {
		throw new Error(`Failed to load GitHub integration config: ${error.message}`);
	}

	if (!data || data.enabled === false) {
		throw new Error(
			"GitHub integration is not configured or disabled in user_integrations. Use integration_set to configure it.",
		);
	}

	return (data.config ?? {}) as GithubReadIntegrationConfig;
}

export async function assertGithubReadRepoAllowed(
	supabase: GenericSupabaseClient,
	userId: string | undefined,
	repo: string,
): Promise<GithubReadIntegrationConfig> {
	const config = await loadGithubIntegrationConfig(supabase, userId);
	const readRepos = Array.isArray(config.read_repos) ? config.read_repos : [];
	const issueRepos = Array.isArray(config.issue_repos) ? config.issue_repos : [];
	const prRepos = Array.isArray(config.pr_repos) ? config.pr_repos : [];
	const combined = [...readRepos, ...issueRepos, ...prRepos];

	if (!combined.some((pattern) => matchesRepoPattern(pattern, repo))) {
		throw new Error(
			`Repository "${repo}" is not in the allowed read_repos, issue_repos, or pr_repos lists in user_integrations.`,
		);
	}

	return config;
}

export async function assertGithubIssueRepoAllowed(
	supabase: GenericSupabaseClient,
	userId: string | undefined,
	repo?: string,
): Promise<string> {
	const config = await loadGithubIntegrationConfig(supabase, userId);
	const issueRepos = Array.isArray(config.issue_repos) ? config.issue_repos : [];

	if (issueRepos.length === 0) {
		throw new Error(
			"No issue_repos configured for GitHub integration in user_integrations. Use integration_set to configure issue_repos.",
		);
	}

	if (repo) {
		if (!issueRepos.some((pattern) => matchesRepoPattern(pattern, repo))) {
			throw new Error(
				`Repository "${repo}" is not in the allowed issue_repos: ${issueRepos.join(", ")}.`,
			);
		}
		return repo;
	}

	if (!config.default_repo) {
		throw new Error(
			"No repo provided and no default_repo configured in user_integrations. Use integration_set to set default_repo or specify repo explicitly.",
		);
	}
	if (!issueRepos.some((pattern) => matchesRepoPattern(pattern, config.default_repo!))) {
		throw new Error(
			`Configured default_repo "${config.default_repo}" is not in the allowed issue_repos: ${issueRepos.join(", ")}.`,
		);
	}
	return config.default_repo;
}

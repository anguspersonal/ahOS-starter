import { env } from "./env.js";

// The one place a provider's SECRET is resolved (ADR-045 seam 1). Non-secret wiring
// (database ids, calendar_id, routing) lives in user_integrations and is read via
// integrations.ts; secrets live in env and are read here. The two never mix — a
// config-printing tool (notion_config_get, integration_list) cannot reach this module,
// which is what makes "secrets can't leak through config reads" structural rather than
// a per-tool discipline.
//
// Why an accessor at all when it just reads env today: ADR-045 designates
// `credential_ref` → vault as the multi-tenant credential path (Option C), and this is
// the function that would consult it. Routing every client through here now turns that
// later change into one implementation swap instead of a rewrite of every client module.

/**
 * A provider whose credential this accessor resolves. These are `user_integrations`
 * provider names, so a caller that already selected a provider's config row (the
 * `workspace` argument on task_create) can pass the same
 * value straight through — config routing and credential routing agree by construction.
 *
 * Notion's two workspaces are separate providers, not one provider with a flag: they
 * are distinct Notion integrations with distinct tokens and disjoint page access.
 *
 * Google's two accounts follow the same rule for the same reason (issue #338): one
 * refresh token per ACCOUNT, covering every Google API that account consented to.
 * The discriminator is deliberately not per-service, because Google does not have a
 * per-service credential and pretending otherwise walks into the scope-bundling trap
 * in ADR-045. See google/accounts.ts.
 *
 * Converted so far: the Notion pair (issue #424), `google/calendar.ts` (issue #338),
 * `google/drive.ts` (issue #857 — its ~20 `getDrive()` call sites now resolve
 * through this same seam), `metaAdsClient.ts` (issue #646) and `synthesizeEntity.ts`
 * (`gemini`, issue #1447). The remaining client modules named in
 * ADR-045 seam 1 (`dexClient.ts`, `brevoClient.ts`, `embeddings.ts`
 * and `anthropic.ts`) still read `env` directly. Each is already a single
 * chokepoint per provider, so converting one is a `CREDENTIALS` entry plus a call
 * swap, not a redesign. Entries are added as modules are converted rather than up
 * front, so this map never claims coverage it doesn't have.
 */
export type CredentialProvider =
	| "notion_work"
	| "notion_personal"
	| "github"
	| "github_issues"
	| "github_pulls"
	| "github_work"
	| "linkedin"
	| "slack"
	| "slack_bot"
	| "google_personal"
	| "google_work"
	| "microsoft_personal"
	| "work_planning"
	| "meta_ads"
	| "revenuecat"
	| "gemini";

type CredentialSource = {
	/**
	 * Env var names in resolution order, quoted verbatim in the setup error — the
	 * failure mode this guards is "the var is set under the other name", so the error
	 * has to name every name that would have worked.
	 */
	envVars: readonly string[];
	/** Reads the resolved value from env; null/undefined when none of `envVars` is set. */
	read: () => string | null | undefined;
	/** What stops working without it. Makes the error actionable at the call site. */
	usedBy: string;
};

const CREDENTIALS: Record<CredentialProvider, CredentialSource> = {
	work_planning: {
		envVars: ["WORK_PLANNING_TOKEN"],
		read: () => env.workPlanningToken,
		usedBy:
			"the Work planning document (planning_read / planning_edit). Mint it into product_design.planning_api_tokens in the Work Supabase project; the row's user_id decides what the token may do (example-org/web-app#114)",
	},
	notion_work: {
		envVars: ["NOTION_WORK_ACCESS_TOKEN", "NOTION_API_KEY"],
		read: () => env.notionApiKey,
		usedBy:
			"Work-workspace Notion calls (state_doc_update, and task_create with workspace='notion_work')",
	},
	notion_personal: {
		envVars: ["NOTION_PERSONAL_ACCESS_TOKEN"],
		read: () => env.notionPersonalToken,
		usedBy:
			"personal-workspace Notion calls (task_create with workspace='notion_personal')",
	},
	github: {
		envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN_INGEST"],
		read: () => env.githubToken,
		usedBy:
			"personal GitHub ingest (ingest_github) and read actions (github_pr_get, github_pr_diff, github_pr_mergeability). A personal access token with read access to Issues, Pull requests, Contents (contents:read), and Actions (actions:read) on personal repositories (legacy alias: GITHUB_TOKEN_INGEST). Create one at https://github.com/settings/tokens. NOT `GITHUB_TOKEN`, which is the separate general-purpose token driving ahOS over the GitHub MCP, and NOT `GITHUB_WORK_ACCESS_TOKEN` (which is for example-org/* repositories)",
	},
	github_issues: {
		envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN_ISSUES", "GITHUB_ISSUES_TOKEN"],
		read: () => env.githubTokenIssues,
		usedBy:
			"personal GitHub issue writes (github_issue_create, github_comment_create, github_label_add, github_label_remove). A personal access token that must carry issues:write for personal repositories. NOT GITHUB_TOKEN, GITHUB_TOKEN_INGEST, or GITHUB_WORK_ACCESS_TOKEN: these actions deliberately never fall back to them",
	},
	github_pulls: {
		envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN_PULLS"],
		read: () => env.githubTokenPulls,
		usedBy:
			"personal GitHub pull request writes (github_pr_create, github_pr_update, github_pr_close). A fine-grained personal access token scoped to personal PR repos with pull_requests:write and contents:write (legacy alias: GITHUB_TOKEN_PULLS). NOT GITHUB_TOKEN_ISSUES, GITHUB_TOKEN_INGEST, GITHUB_TOKEN, or GITHUB_WORK_ACCESS_TOKEN: these actions deliberately never fall back to them",
	},
	github_work: {
		envVars: ["GITHUB_WORK_ACCESS_TOKEN"],
		read: () => env.githubTokenWork,
		usedBy:
			"Work (example-org/*) GitHub operations (reads, issue/comment/label writes, pull request writes, and ingest_github when targeting example-org/*). A fine-grained personal access token scoped to the example-org organization. Never falls back to personal GitHub tokens (GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_TOKEN_INGEST, GITHUB_TOKEN_PULLS, or GITHUB_TOKEN)",
	},
	linkedin: {
		envVars: ["LINKEDIN_ACCESS_TOKEN"],
		read: () => env.linkedinAccessToken,
		usedBy:
			"posting to LinkedIn (linkedin_post, #1632). Must be a 60-day LinkedIn OAuth member access token scoped openid, profile, w_member_social (#1631)",
	},
	slack: {
		envVars: ["SLACK_TOKEN_USER_OAUTH"],
		read: () => env.slackUserToken,
		usedBy:
			"Slack ingest, reads, and owner writes (ingest_slack, slack_read_*, slack_search, slack_message_update / slack_message_delete with as='owner', and slack_reaction_add). The USER token (xoxp-) from the Slack app, not its bot token (xoxb-, typically SLACK_TOKEN_BOT_OAUTH): search.messages is unavailable to bots, and only a user token can reach the owner's DMs or edit/delete the owner's messages. Needs `search:read`, `chat:write`, and `reactions:write` scopes. The bot token is slack_bot below, never the user token's fallback",
	},
	google_personal: {
		envVars: ["GOOGLE_REFRESH_TOKEN_PERSONAL", "GOOGLE_REFRESH_TOKEN"],
		read: () => env.googleRefreshToken,
		usedBy:
			"personal-account Google calls (drive_*, event_create, and any tool called with account='personal'). Mint it with `npm --workspace @ahkms/mcp-server run google-auth -- --account personal` while signed in as the gmail.com user",
	},
	google_work: {
		envVars: ["GOOGLE_REFRESH_TOKEN_WORK"],
		read: () => env.googleRefreshTokenWork,
		usedBy:
			"Work-account Google calls (any tool called with account='work'). Mint it with `npm --workspace @ahkms/mcp-server run google-auth -- --account work` while signed in as the work.example.com user",
	},
	microsoft_personal: {
		envVars: ["MICROSOFT_REFRESH_TOKEN_PERSONAL"],
		read: () => env.microsoftRefreshTokenPersonal,
		usedBy:
			"personal Microsoft OneDrive calls (onedrive_*). Mint it with `npm --workspace @ahkms/mcp-server run microsoft-auth` while signed in as the personal Microsoft account user",
	},
	meta_ads: {
		envVars: ["META_ADS_ACCESS_TOKEN"],
		read: () => env.metaAdsAccessToken,
		usedBy:
			"the Meta Ads tools (meta_ads_list_tools / meta_ads_call_tool, #646). Must be a long-lived Meta system-user access token scoped `ads_read` only — never `ads_management`, since this integration reads campaign/insights data and never mutates a campaign. Mint one in Meta Business Settings → Users → System Users → Generate New Token, granting the ad account(s) to read and the `ads_read` permission",
	},
	slack_bot: {
		// SLACK_TOKEN_BOT_OAUTH pairs with SLACK_TOKEN_USER_OAUTH (the two tokens a Slack
		// app hands out) and is the name provisioned on Railway; SLACK_BOT_TOKEN is the
		// name this seam first read, kept as a legacy fallback.
		envVars: ["SLACK_TOKEN_BOT_OAUTH", "SLACK_BOT_TOKEN"],
		read: () => env.slackBotToken,
		usedBy:
			"posting to Slack (slack_post, #647), editing or deleting bot messages (slack_message_update / slack_message_delete with as='ahos_bot', #1526), and Slack approval cards (chat.postMessage / chat.update, #1534, #1544). Must be the Slack app's BOT token (xoxb-) scoped `chat:write`, not SLACK_TOKEN_USER_OAUTH (the separate user token slack_ingest reads for search.messages); the two tokens have disjoint jobs and there is no fallback between them",
	},
	revenuecat: {
		envVars: ["REVENUECAT_API_KEY"],
		read: () => env.revenuecatApiKey,
		usedBy:
			"the RevenueCat metrics tool (revenuecat_get_metrics, #647). Must be a RevenueCat v2 (Production) secret API key, read-only use — this client issues GETs only. Mint one in RevenueCat → Project settings → API keys",
	},
	gemini: {
		envVars: ["GEMINI_API_KEY"],
		read: () => env.geminiApiKey,
		usedBy:
			"primary 1536d vector embeddings (gemini-embedding-001, #1974) and the default Gemini 2.5 Flash LLM path across entity_derive, entity_synthesize (#1447), L2 document summarization, and artifact_extract_text. Must be a Google Gemini API key",
	},
};

/** Every fixed provider this accessor resolves, in declaration order. */
export const CREDENTIAL_PROVIDERS = Object.keys(CREDENTIALS) as CredentialProvider[];

/**
 * Which accepted env var name a fixed provider's secret was found under, WITHOUT the
 * value (#1024, ahos_doctor). `setUnder` is the first name in resolution order that is
 * set, so "found under the legacy name" is distinguishable from "found under the
 * primary one" — the #1021 class, where a secret existed under a name the code did not
 * read, is only diagnosable if the answer names the name.
 */
export function describeCredential(provider: CredentialProvider): {
	envVars: readonly string[];
	setUnder: string | null;
	usedBy: string;
} {
	const source = CREDENTIALS[provider];
	return {
		envVars: source.envVars,
		setUnder: source.envVars.find((name) => Boolean(process.env[name])) ?? null,
		usedBy: source.usedBy,
	};
}

/**
 * A connection-scoped provider FAMILY (ADR-060).
 *
 * The map above is a closed set because each of its entries needs a human ceremony to
 * add — a Notion integration to install, a Google consent screen to complete. PostHog
 * is not like that: a project is an integer, and the set of them changes for reasons
 * that have nothing to do with this codebase (a second product, a side project, someone
 * else's site). Encoding that list as a union would make "add a project" mean a pull
 * request and a deploy.
 *
 * So the asymmetry is deliberate and load-bearing: adding a FAMILY is an entry here,
 * which is rare and is a real decision. Adding a CONNECTION inside a family is an env
 * var plus a `user_integrations` row, with no code change and no deploy.
 */
const CONNECTION_FAMILIES: Record<
	string,
	{ envPrefix: string; usedBy: string; usedByWrite?: string }
> = {
	posthog: {
		envPrefix: "POSTHOG_API_KEY",
		usedBy:
			"PostHog reads for one connection (posthog_* tools called with that connection). Mint a personal API key scoped to project:read + query:read",
		usedByWrite:
			"PostHog WRITES for one connection (posthog_write). This is a SECOND key, deliberately separate from the read key, so the read path keeps its read-only-by-construction property and a compromised read surface still cannot mutate anything. Mint a personal API key with only the write scopes you actually intend to use (e.g. cohort:write), never a blanket-scoped key",
	},
};

/**
 * Each connection family's env var prefix, e.g. `posthog` → `POSTHOG_API_KEY`. For the
 * doctor (#1024), which lists the connections actually present in env; resolution
 * itself never enumerates (see connectionEnvVar).
 */
export function connectionFamilyPrefixes(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(CONNECTION_FAMILIES).map(([family, f]) => [family, f.envPrefix]),
	);
}

/** `<family>:<slug>`, e.g. `posthog:work`. Resolved dynamically, never enumerated. */
export type ConnectionRef = `${string}:${string}`;

/** Either a fixed provider or a connection. The one thing `getCredential` accepts. */
export type CredentialRef = CredentialProvider | ConnectionRef;

/**
 * `posthog:work` → `POSTHOG_API_KEY_WORK`.
 *
 * Exported so the setup error, the smoke script and the docs can all name the same
 * variable. A convention that only exists inside the resolver is one that every caller
 * has to guess at, and guessing at an env var name fails as "credential missing" rather
 * than as "you spelled it wrong".
 */
export function connectionEnvVar(
	ref: ConnectionRef,
	opts: { write?: boolean } = {},
): string {
	const [family, slug] = splitConnectionRef(ref);
	const suffix = slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	// The write key is a separate variable rather than a wider scope on the read one.
	// Two keys means the read path cannot mutate anything even if every guard above it
	// is wrong, which is the property client.ts was originally built around and the one
	// thing a general write passthrough would otherwise give away.
	const write = opts.write ? "_WRITE" : "";
	return `${CONNECTION_FAMILIES[family].envPrefix}_${suffix}${write}`;
}

function splitConnectionRef(ref: ConnectionRef): [string, string] {
	const idx = ref.indexOf(":");
	const family = ref.slice(0, idx);
	const slug = ref.slice(idx + 1);

	// Both halves are checked before the env lookup, because an unknown family and an
	// empty slug both produce a plausible-looking variable name that is simply never
	// set — a missing-credential error for what is actually a typo.
	if (!CONNECTION_FAMILIES[family]) {
		throw new Error(
			`Unknown connection family '${family}' in credential ref '${ref}'. Known families: ${
				Object.keys(CONNECTION_FAMILIES).join(", ") || "(none)"
			}. Adding a family is a code change in credentials.ts; adding a connection within one is not.`,
		);
	}
	if (!slug) {
		throw new Error(`Credential ref '${ref}' has an empty connection slug.`);
	}
	return [family, slug];
}

/**
 * Thrown by `getCredential` for the one recoverable case — this provider/connection
 * is simply not wired up yet — as opposed to a typo, a config bug, or (once ADR-045's
 * multi-tenant path lands) a vault outage. `hasCredential` is the only caller allowed
 * to treat this one as "false"; every other error still propagates.
 */
export class CredentialNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialNotConfiguredError";
	}
}

function resolveConnectionCredential(
	ref: ConnectionRef,
	opts: { write?: boolean } = {},
): string {
	const [family] = splitConnectionRef(ref);
	const name = connectionEnvVar(ref, opts);
	const value = process.env[name];
	if (!value) {
		const usedBy = opts.write
			? (CONNECTION_FAMILIES[family].usedByWrite ??
				`writes for the ${family} family, which declares no write credential`)
			: CONNECTION_FAMILIES[family].usedBy;
		throw new CredentialNotConfiguredError(
			`${name} is not set — required for ${usedBy}. See packages/mcp-server/.env.example`,
		);
	}
	// Never fall back to the read key. A write attempted with a read-scoped key fails at
	// PostHog as a 403 about scopes, which reads as "the API changed" rather than "the
	// write key was never minted", and sends you to the wrong place entirely.
	return value;
}

/**
 * Is this provider wired, without the loud failure?
 *
 * For ONE question only: "should this run even attempt this account". The scheduled
 * Drive cadence (#857) iterates the accounts that exist and must skip the ones nobody
 * has minted a token for, which is a routine state on a single-account install, not an
 * error worth a run row.
 *
 * It is NOT a way to soften `getCredential` at a call site that is about to do work.
 * Every such caller should let that function throw and name the env var: a silent skip
 * where a user expected a write is the failure #424 was about, one level up.
 *
 * Only catches `CredentialNotConfiguredError` — anything else `getCredential` throws
 * (an unknown connection family, an empty slug, a future vault failure) is a real bug
 * or outage, not "not configured", and must propagate rather than read as "false".
 */
export async function hasCredential(ref: CredentialRef): Promise<boolean> {
	try {
		await getCredential(ref);
		return true;
	} catch (err) {
		if (err instanceof CredentialNotConfiguredError) return false;
		throw err;
	}
}

/**
 * Resolve a provider's secret, or throw a setup error naming the exact env var(s) that
 * would satisfy it.
 *
 * Never falls back to another provider's credential. That fallback is the bug this
 * replaced: a `notion_personal` call selected the personal database id but authenticated
 * with the work token, so it failed against Notion as a 404 (the work integration cannot
 * see personal pages) rather than as a missing-configuration error (#424 defect 1). A
 * loud, named failure at the boundary beats a misleading one from the API.
 *
 * Async despite resolving synchronously today: the multi-tenant implementation reads
 * `user_integrations.credential_ref` and dereferences it against a vault, which is I/O.
 * Committing to the async signature now is the difference between swapping this
 * function's body later and re-threading every caller (ADR-045 seam 1).
 */
export async function getCredential(
	ref: CredentialRef,
	opts: { write?: boolean } = {},
): Promise<string> {
	// A ref carrying a colon names a CONNECTION, not one of the fixed providers above.
	// Split here rather than merging the two into one map, because they differ in the
	// property that matters: the fixed set is knowable at compile time, and the
	// connection set is not.
	if (ref.includes(":")) return resolveConnectionCredential(ref as ConnectionRef, opts);

	// Only connection families have a write credential today. A fixed provider asking
	// for one is a programming error, not a setup error, so it fails here rather than
	// silently handing back the read secret.
	if (opts.write) {
		throw new Error(
			`getCredential('${ref}', { write: true }) is not supported: only connection-scoped families declare a separate write credential.`,
		);
	}

	const source = CREDENTIALS[ref as CredentialProvider];

	// Multi-tenant insertion point: resolve credential_ref → vault HERE, ahead of the
	// env fallthrough, so single-tenant deployments keep working unchanged.
	const value = source.read();

	if (!value) {
		const names =
			source.envVars.length > 1
				? `${source.envVars[0]} (or legacy ${source.envVars.slice(1).join(" / ")})`
				: source.envVars[0];
		throw new CredentialNotConfiguredError(
			`${names} is not set — required for ${source.usedBy}. See packages/mcp-server/.env.example`,
		);
	}

	return value;
}

/**
 * True when `repo` targets the Work (`example-org`) GitHub organization — e.g.
 * `"example-org/work"`, `"example-org/*"`, or `"example-org"`.
 *
 * GitHub fine-grained Personal Access Tokens are bound to a single resource owner,
 * so `example-org/*` repositories must authenticate with `GITHUB_WORK_ACCESS_TOKEN`
 * (`github_work`) and never fall back to the personal token.
 */
export function isWorkGithubRepo(repo?: string | null): boolean {
	if (!repo) return false;
	const normalized = repo.trim().toLowerCase();
	return normalized === "example-org" || normalized.startsWith("example-org/");
}

/**
 * Resolve the GitHub credential for a given operation category and optional target
 * `owner/repo`. When `repo` is in `example-org/*`, resolves `github_work`
 * (`GITHUB_WORK_ACCESS_TOKEN`) with no fallback to personal tokens; otherwise
 * resolves the personal provider (`github`, `github_issues`, or `github_pulls`).
 */
export async function getGithubCredential(
	personalProvider: "github" | "github_issues" | "github_pulls",
	repo?: string | null,
): Promise<string> {
	if (isWorkGithubRepo(repo)) {
		return getCredential("github_work");
	}
	return getCredential(personalProvider);
}

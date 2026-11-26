/** Comma-separated id list to a trimmed array; null when unset/blank (= no filter). */
function parseIdList(raw: string | undefined): string[] | null {
	const ids = (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return ids.length ? ids : null;
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`Missing required env var ${name}. See packages/mcp-server/.env.example`,
		);
	}
	return value;
}

/**
 * Lazy per-key resolution (#508): every property is a getter, so `required()`
 * fires on first ACCESS of a key rather than at module import. A one-time script
 * like `google-auth` can therefore boot with only the vars it actually touches
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) instead of needing the Supabase
 * service-role key pasted into .env first — the fewer contexts that secret must
 * be present in, the better (ADR-045 open question).
 *
 * Fail-fast is preserved, just relocated: modules that read a required key at
 * their own module scope (e.g. supabase.ts builds its client at import) still
 * throw the same "Missing required env var …" error at import of THAT module.
 *
 * Getters re-read process.env on each access (no caching) — values are stable
 * in practice, and uncached getters keep this a pure relocation of `required()`
 * with no new state. Note for callers: spreading or `Object.keys/values`-ing
 * `env` invokes EVERY getter and so demands every required var — access keys
 * individually instead (no such call site exists in src/ today; test mocks that
 * spread `actual.env` run under vitest.config.ts's stubbed core vars — the
 * spread evaluates each getter once at mock-factory time, so those mocks get a
 * plain WRITABLE object and their `env.x = "y"` assignments keep working).
 * A test that imports the real `env` (no `vi.mock("../env.js")`) must stub
 * `process.env.*` instead — assigning to these getter-only properties throws
 * (strict ESM) or silently no-ops; see calendar.test.ts.
 */
export const env = {
	get supabaseUrl() {
		return required("SUPABASE_URL");
	},
	get supabaseServiceRoleKey() {
		return required("SUPABASE_SERVICE_ROLE_KEY");
	},
	// Single-user tool: every artifact is owned by this user (Phase 0, service-role).
	get userId() {
		return required("KMS_USER_ID");
	},
	// Must match the bucket the rest of the app uses. Worker hard-codes
	// 'user-uploads'; the storage RLS policies in migration 023 only cover it.
	get storageBucket() {
		return process.env.KMS_STORAGE_BUCKET ?? "user-uploads";
	},
	// Optional: fallback LLM provider for artifact_extract_text, L2 summaries, entity_derive,
	// and entity_synthesize when GEMINI_API_KEY is unset or provider='anthropic' is requested.
	get anthropicApiKey() {
		return process.env.ANTHROPIC_API_KEY;
	},
	// Optional: primary LLM (gemini-2.5-flash) and embeddings (1536d gemini-embedding-001, #1974)
	// provider across entity_derive, entity_synthesize, L2 summaries, and artifact_extract_text.
	get geminiApiKey() {
		return process.env.GEMINI_API_KEY;
	},
	get geminiEmbedModel() {
		return process.env.KMS_GEMINI_EMBED_MODEL ?? "gemini-embedding-001";
	},
	get geminiExtractModel() {
		return process.env.KMS_GEMINI_EXTRACT_MODEL ?? "gemini-2.5-flash";
	},
	get extractModel() {
		return process.env.KMS_EXTRACT_MODEL ?? "claude-opus-4-7";
	},
	// Optional: fallback embeddings provider when GEMINI_API_KEY is unset. When neither
	// GEMINI_API_KEY nor OPENAI_API_KEY is set, search degrades to FTS-only and capture/
	// extract skip the embed step entirely. Reuses the same key as other OpenAI usage.
	get openaiApiKey() {
		return process.env.OPENAI_API_KEY;
	},
	get embedModel() {
		return process.env.KMS_EMBED_MODEL ?? "text-embedding-3-small";
	},
	// Notion is split across two workspaces (Work/WORK vs personal) — see ADR-023
	// (sibling read-side consumers for personal and infra workspaces). This is the
	// Work/work token: used by state_doc_update and by task_create
	// when targeting workspace='notion_work' (the default).
	// NOTION_WORK_ACCESS_TOKEN is the primary var (matches the Railway prod naming);
	// NOTION_API_KEY is kept as a fallback for existing local/test setups. The non-secret
	// database id lives in user_integrations; this is the secret token and stays in env.
	get notionApiKey() {
		return process.env.NOTION_WORK_ACCESS_TOKEN ?? process.env.NOTION_API_KEY;
	},
	// Optional: token for the personal Notion workspace. Consumed when a tool targets
	// workspace='notion_personal' (task_create) — selected via
	// getCredential('notion_personal') so a personal call authenticates with THIS token
	// rather than the work one (issue #424 defect 1). Unblocks the personal read path
	// (notion_search / #339). See ADR-023, and ADR-045 for the credential seam.
	get notionPersonalToken() {
		return process.env.NOTION_PERSONAL_ACCESS_TOKEN ?? null;
	},
	// Optional: HMAC key for verifying inbound Notion webhook deliveries on
	// POST /webhooks/notion (#546 / ADR-048). This is the `verification_token` Notion
	// sends in the subscription handshake; until it is set the endpoint logs the
	// received token (for the operator to paste into the Notion UI) and skips all
	// event processing. Secret — env only, never user_integrations (ADR-045).
	get notionWebhookVerificationToken() {
		return process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN ?? null;
	},
	// Optional: pre-shared secret token for inbound direct artifact capture on
	// POST /webhooks/capture (ADR-048). Delivered via `X-Capture-Secret` header or
	// `Authorization: Bearer <secret>`.
	get captureWebhookSecret() {
		return process.env.CAPTURE_WEBHOOK_SECRET ?? null;
	},
	// Optional: signing secret for inbound Slack Events API deliveries on
	// POST /webhooks/slack (ADR-048). Delivered via `X-Slack-Signature` HMAC.
	get slackSigningSecret() {
		return process.env.SLACK_SIGNING_SECRET ?? null;
	},
	// Optional: comma-separated Slack workspace (team) ids allowed on POST /webhooks/slack.
	// Unset = no team filter.
	get slackAllowedTeamIds() {
		return parseIdList(process.env.SLACK_ALLOWED_TEAM_IDS);
	},
	// Optional: comma-separated Slack channel ids ingested by POST /webhooks/slack.
	// Unset = every channel/DM the app can see (the pre-allowlist behaviour).
	get slackAllowedChannelIds() {
		return parseIdList(process.env.SLACK_ALLOWED_CHANNEL_IDS);
	},
	// Optional: verification token for inbound Google Drive push notifications on
	// POST /webhooks/drive (ADR-048). Delivered via `X-Goog-Channel-Token`.
	get driveWebhookToken() {
		return process.env.DRIVE_WEBHOOK_TOKEN ?? null;
	},
	// Optional: only needed by the Google Drive tools (drive_*). Left unset, the
	// knowledge-store tools (capture/search/get/extract) still work — getDrive()
	// throws a clear setup error only when a Drive tool is actually invoked.
	// Mint a refresh token once with `npm --workspace @ahkms/mcp-server run google-auth`.
	get googleClientId() {
		return process.env.GOOGLE_CLIENT_ID;
	},
	get googleClientSecret() {
		return process.env.GOOGLE_CLIENT_SECRET;
	},
	// GOOGLE_REFRESH_TOKEN_PERSONAL is the primary var: the two accounts are now named
	// symmetrically (_PERSONAL / _WORK) so neither is the unsuffixed default one.
	// That asymmetry is what let a personal token be pasted into the work slot on
	// 2026-09-05 and go undetected (#1002). GOOGLE_REFRESH_TOKEN is kept as a fallback
	// for local .env files minted before the rename, same shape as the Notion pair above.
	get googleRefreshToken() {
		return (
			process.env.GOOGLE_REFRESH_TOKEN_PERSONAL ?? process.env.GOOGLE_REFRESH_TOKEN
		);
	},
	// Optional: refresh token for the Work Google Workspace account (issue #338).
	// A second Google ACCOUNT, not a second service: one refresh token covers Drive,
	// Calendar and Gmail for whichever account consented, so this is the whole
	// credential for google_work. Selected via getCredential('google_work')
	// when a caller passes account='work'. Left unset, personal-account calls are
	// unaffected and only Work-targeted calls fail, naming this var. Mint with
	// `npm --workspace @ahkms/mcp-server run google-auth -- --account work`
	// while signed in as the work.example.com user. See ADR-045 for the credential seam.
	get googleRefreshTokenWork() {
		return process.env.GOOGLE_REFRESH_TOKEN_WORK ?? null;
	},
	// Optional: only needed by the personal Microsoft OneDrive tools (onedrive_*).
	// Mint a refresh token once with `npm --workspace @ahkms/mcp-server run microsoft-auth`.
	get microsoftClientId() {
		return process.env.MICROSOFT_CLIENT_ID;
	},
	get microsoftClientSecret() {
		return process.env.MICROSOFT_CLIENT_SECRET ?? null;
	},
	get microsoftRefreshTokenPersonal() {
		return process.env.MICROSOFT_REFRESH_TOKEN_PERSONAL ?? null;
	},
	get microsoftOAuthRedirect() {
		return (
			process.env.MICROSOFT_OAUTH_REDIRECT ??
			"http://localhost:53683/oauth2callback"
		);
	},
	// Optional: personal GitHub access token for `ingest_github` (#1010) and personal
	// repo read actions (`github_*`). Consolidated onto GITHUB_PERSONAL_ACCESS_TOKEN,
	// with legacy fallback to GITHUB_TOKEN_INGEST.
	//
	// Deliberately NOT `GITHUB_TOKEN`, and deliberately with no fallback to it or to
	// `GITHUB_WORK_ACCESS_TOKEN` (which is scoped to example-org/* repos).
	get githubToken() {
		return (
			process.env.GITHUB_PERSONAL_ACCESS_TOKEN ??
			process.env.GITHUB_TOKEN_INGEST ??
			null
		);
	},
	// Optional: personal GitHub access token with issues:write permission for `github_issue_create` (ADR-101, #1926).
	// Canonical name: GITHUB_PERSONAL_ACCESS_TOKEN (legacy aliases: GITHUB_TOKEN_ISSUES, GITHUB_ISSUES_TOKEN).
	// Must have issues:write scope. No fallback to GITHUB_TOKEN, GITHUB_TOKEN_INGEST, or GITHUB_WORK_ACCESS_TOKEN.
	get githubTokenIssues() {
		return (
			process.env.GITHUB_PERSONAL_ACCESS_TOKEN ??
			process.env.GITHUB_TOKEN_ISSUES ??
			process.env.GITHUB_ISSUES_TOKEN ??
			null
		);
	},
	// Optional: personal GitHub access token with pull_requests:write and contents:write for
	// personal PR actions (`github_pr_create`, `github_pr_update`, `github_pr_close`).
	// Consolidated onto GITHUB_PERSONAL_ACCESS_TOKEN (legacy alias: GITHUB_TOKEN_PULLS).
	get githubTokenPulls() {
		return (
			process.env.GITHUB_PERSONAL_ACCESS_TOKEN ??
			process.env.GITHUB_TOKEN_PULLS ??
			null
		);
	},
	// Optional: fine-grained GitHub personal access token scoped to the Work (`example-org`)
	// organization. Used for all GitHub operations (reads, issue/comment/label writes,
	// pull request writes, and ingest_github) when targeting `example-org/*` repositories.
	// Never falls back to personal GitHub tokens.
	get githubTokenWork() {
		return process.env.GITHUB_WORK_ACCESS_TOKEN ?? null;
	},
	// Optional: a Slack USER token (xoxp-) for `ingest_slack` (#1011). Must be a user
	// token, not a bot token: search.messages is not available to bots at all, and only
	// a user token can see the owner's DMs. Read-only use. Left unset, only
	// ingest_slack fails, naming this var.
	//
	// The `_USER_OAUTH` suffix names which of the two tokens a Slack app hands out. The
	// app also issues a bot token (`xoxb-`, SLACK_TOKEN_BOT_OAUTH), which only slack_post
	// reads (slackBotToken below): the one job this credential has, search.messages, a
	// bot token cannot do at all. A name that said only "slack" would be the one you
	// reach for when both are in front of you.
	get slackUserToken() {
		return process.env.SLACK_TOKEN_USER_OAUTH ?? null;
	},
	// Loopback redirect used only by the one-time google-auth helper. Keep the
	// default aligned with scripts/google-oauth.ts and .env.example to avoid a
	// silent mismatch in the one-time auth flow. The project's OAuth client is a
	// **Web application** client, so this exact URI (scheme, port, and path) must
	// be registered under "Authorized redirect URIs" in Google Cloud Console —
	// any mismatch fails with `Error 400: redirect_uri_mismatch` (#508).
	get googleOAuthRedirect() {
		return (
			process.env.GOOGLE_OAUTH_REDIRECT ?? "http://localhost:53682/oauth2callback"
		);
	},
	// Optional: only needed by dex_call_tool (dex_list_tools reads a local catalog and
	// works without it). Left unset, all other tools still work — callDexTool() throws a
	// clear setup error only when a Dex tool is invoked.
	// Requires a Dex Professional plan API key (https://getdex.com).
	get dexApiKey() {
		return process.env.DEX_API_KEY;
	},
	// Optional: only needed by the Brevo tools (brevo_*). Left unset, all other tools
	// still work — brevoClient throws a clear setup error only when a Brevo tool is
	// invoked. This must be an MCP-ENABLED Brevo API key (Brevo → Account → SMTP & API →
	// API Keys → toggle "Create MCP server API key"), not a plain REST key. See ADR-055.
	get brevoMcpApiKey() {
		return process.env.BREVO_MCP_API_KEY;
	},
	// Optional: only needed by the Meta Ads tools (meta_ads_*, #646). Left unset, all
	// other tools still work — metaAdsClient throws a clear setup error only when a
	// Meta Ads tool is invoked. Must be a long-lived Meta SYSTEM USER access token
	// scoped read-only (`ads_read`) — deliberately NOT `ads_management`: this
	// integration reads campaign/insights data and never mutates a campaign. Mint one
	// in Meta Business Settings → Users → System Users → Generate New Token, granting
	// it the ad account(s) to read and the `ads_read` permission only.
	get metaAdsAccessToken() {
		return process.env.META_ADS_ACCESS_TOKEN;
	},
	// Optional: only needed by the Slack post tool (slack_post, #647). Left unset, all
	// other tools still work — slackClient throws a clear setup error only when
	// slack_post is invoked. Must be the Slack app's BOT token (xoxb-), scoped
	// `chat:write`, not the user token slack_ingest reads (SLACK_TOKEN_USER_OAUTH):
	// posting as the bot is the whole job here, and the ingest's user token has no
	// bearing on it. Install the app to the channel(s) it should post to. Read from
	// SLACK_TOKEN_BOT_OAUTH (the provisioned name, paired with _USER_OAUTH), falling
	// back to the legacy SLACK_BOT_TOKEN.
	get slackBotToken() {
		return process.env.SLACK_TOKEN_BOT_OAUTH ?? process.env.SLACK_BOT_TOKEN;
	},
	// Optional: only needed by the RevenueCat metrics tool (revenuecat_get_metrics,
	// #647). Left unset, all other tools still work — revenuecatClient throws a clear
	// setup error only when that tool is invoked. Must be a RevenueCat v2 (Production)
	// secret API key, read-only use only: this client issues GETs against the metrics
	// endpoint and nothing else. Mint one in RevenueCat → Project settings → API keys.
	get revenuecatApiKey() {
		return process.env.REVENUECAT_API_KEY;
	},
	// Optional: only needed by the native LinkedIn post action (linkedin_post, #1632).
	// Left unset, all other tools still work; linkedin_post throws a clear setup error
	// naming this var when invoked. Must be a 60-day LinkedIn OAuth member access token
	// minted via the LinkedIn Developer Portal (scopes: openid, profile, w_member_social).
	get linkedinAccessToken() {
		return process.env.LINKEDIN_ACCESS_TOKEN ?? null;
	},
	// Optional: only needed by the planning tools (planning_read / planning_edit).
	// Left unset, every other tool still works — the planning client throws a clear
	// setup error only when a planning tool is invoked. This is a bearer token minted
	// into product_design.planning_api_tokens in the Work Supabase project, acting
	// as a team-tier user, so it can read and edit the planning document and cannot
	// seal a screen or delete a snapshot (example-org/web-app#114).
	get workPlanningToken() {
		return process.env.WORK_PLANNING_TOKEN;
	},
	// Which deployment the planning tools talk to. Deployment wiring rather than user
	// config, so it sits here beside the storage bucket rather than in
	// user_integrations: there is one planning document and the only question is which
	// host serves it. Point it at localhost:3001 to work against a local web-app.
	get workPlanningBaseUrl() {
		return (
			process.env.WORK_PLANNING_BASE_URL ?? "https://planning.example.com"
		).replace(/\/+$/, "");
	},
	// Optional: public base URL of the ahOS web UI (e.g. https://ahos.example.com).
	// Used by Slack approval cards (#1534) to render an "Open in Approvals" link button
	// pointing to <AHOS_WEB_URL>/approvals. When unset, the card omits the URL button.
	get ahosWebUrl() {
		const raw = process.env.AHOS_WEB_URL?.trim();
		return raw ? raw.replace(/\/+$/, "") : null;
	},
};

/**
 * Config for the remote, authenticated HTTP serving surface (ADR-019 follow-up #1 /
 * issue #84). Read lazily — only `http.ts` calls this — so the stdio entry point keeps
 * working locally without any of the OAuth vars set. The Supabase service-role key
 * (above) stays server-side; clients authenticate with an OAuth token, never that key.
 */
export function httpEnv() {
	return {
		// Port Railway (or any host) injects. Defaults to 8080 for local `start:http`.
		port: Number(process.env.PORT ?? 8080),
		// The server's own public HTTPS origin, e.g. https://your-app.up.railway.app — used as
		// the OAuth issuer and resource identifier in discovery metadata. Must be the exact
		// externally-reachable base URL (no trailing slash) or MCP clients reject the handshake.
		publicUrl: required("MCP_PUBLIC_URL").replace(/\/+$/, ""),
		// The single-owner login gate: the password entered on the OAuth consent screen.
		// This is the credential that makes "unauthenticated calls are rejected" real.
		ownerPassword: required("MCP_OWNER_PASSWORD"),
		// HMAC secret for signing stateless access/refresh JWTs. Rotating it invalidates all
		// outstanding tokens (forces re-auth). Generate with `openssl rand -hex 32`.
		jwtSecret: required("MCP_OAUTH_JWT_SECRET"),
		// Access-token lifetime (seconds). Default 30d (matches refreshTokenTtl so clients
		// that do not persist refreshed access tokens across restarts do not expire hourly, #2025).
		accessTokenTtl: Number(process.env.MCP_ACCESS_TOKEN_TTL ?? 30 * 24 * 60 * 60),
		// Refresh-token lifetime (seconds). Default 30d.
		refreshTokenTtl: Number(process.env.MCP_REFRESH_TOKEN_TTL ?? 30 * 24 * 60 * 60),
	};
}

export type HttpEnv = ReturnType<typeof httpEnv>;

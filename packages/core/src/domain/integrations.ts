import { z } from "zod";

// Per-user external wiring (non-secret pointers) persisted in user_integrations.
// Tokens never live here - they come from env. See migration 046.

// provider='notion_work' — the Work workspace (tasks, dos-hl state doc, etc.)
export const notionConfigSchema = z.object({
	tasks_database_id: z.string().min(1),
	title_property: z.string().default("Name"),
	property_map: z.record(z.string(), z.string()).default({}),

	// --- dos, `work` domain (ADR-018 §7, ADR-054 §7) ---
	// Per-user pointers the dos synthesis ritual needs. All optional: only the keys
	// dos actually uses need to be populated. Tools that don't run dos ignore them.
	notion_connector: z.string().optional(),
	notion_workspace: z.string().optional(),
	state_doc_page_id: z.string().optional(), // required for state_doc_update
	// The Daily Log destination, as a database_id/data_source_id PAIR (#674). The two
	// ids are unrelated values and each has its own job: the database id is the WRITE
	// parent (daily_log_create / createNotionPage post `parent: { database_id }`),
	// the data source id is the READ half (the tail query and the duplicate guard).
	// `daily_log_database_id` is new on this schema so both domains answer one lookup;
	// it is legitimately unset until the Work Daily Log DB is connected to the ahKMS
	// integration (#655) and the id is wired.
	daily_log_database_id: z.string().optional(),
	daily_log_data_source_id: z.string().optional(),
	tasks_source_data_source_id: z.string().optional(),
	meetings_source_data_source_id: z.string().optional(),
	investor_crm_data_source_id: z.string().optional(),
	// The Contacts database, added for meeting_create/contact_create (#1059). The personal
	// side already had its equivalent (`people_data_source_id`) and keeps that name: renaming
	// a live config key to make the two schemas symmetric would break every row already written.
	contacts_data_source_id: z.string().optional(),
	notion_user_id: z.string().optional(),

	// --- private meetings source (#617, ADR-053 §6) ---
	// A SECOND, separately-named pointer at the private Meetings DB. Deliberately not
	// an array on meetings_source_data_source_id: that key does two jobs (read source
	// for the Recent Communications projection AND the capture write destination), and
	// a list cannot say which element a new meeting is written to.
	//
	// dos READS this source so its reasoning is not blind to the meetings that
	// matter most. Its content is NEVER projected into the State Doc — Notion exposes
	// no API for page-level sharing (an ACL can be neither set nor read
	// programmatically), so no write can be preceded by a check of who can see it.
	// Read-but-never-project is the rule that survives not knowing the answer.
	// The read/project/write split is computed in meetingsSources.ts; the rule itself
	// is stated at its point of use in .claude/skills/dos/SKILL.md and is a rule in
	// a skill body, NOT an enforced permission.
	private_meetings_source_data_source_id: z.string().optional(),

	// --- capture routing destinations (#299, capture consolidation slice 4) ---
	// Where synthesis-time consumers route Work-context content. One user's
	// private wiring — NEVER hardcoded in a skill body or server source
	// (ADR-018 + docs/design/capture-skill-consolidation.md).
	// NOTE (#487 / ADR-050 §4): The Notion Inbox DB is decommissioned as a synthesis
	// source. dos_inbox_data_source_id is retained as an optional property for
	// backwards compatibility with stored configs, but is no longer actively routed to.
	// The Work Meetings destination is meetings_source_data_source_id above.
	dos_inbox_data_source_id: z.string().optional(),
});

export type NotionConfig = z.infer<typeof notionConfigSchema>;

// --- Notion automations capability v0 (#546 / ADR-048) ---
// One rule type per key under `automations`; the family grows by adding rule keys,
// never by widening an existing rule's surface. All values are non-secret pointers
// (ids + property names) — the webhook verification token is env-only, per ADR-045.
export const completedAtStampRuleSchema = z.object({
	// Data source id of the personal Tasks DB the rule watches.
	data_source_id: z.string().min(1),
	// Name of the status property, e.g. "Status".
	status_property: z.string().min(1),
	// Status option names that count as done, e.g. ["Done"].
	done_values: z.array(z.string().min(1)).min(1),
	// Name of the date property to stamp/clear, e.g. "Completed at".
	completed_at_property: z.string().min(1),
});

export type CompletedAtStampRule = z.infer<typeof completedAtStampRuleSchema>;

// provider='notion_personal' — the personal Notion workspace (tasks, people, meeting notes)
export const notionPersonalConfigSchema = z.object({
	tasks_database_id: z.string().min(1),
	title_property: z.string().default("Name"),
	property_map: z.record(z.string(), z.string()).default({}),
	people_database_id: z.string().optional(),
	meeting_notes_database_id: z.string().optional(),
	tasks_data_source_id: z.string().optional(),
	people_data_source_id: z.string().optional(),
	meeting_notes_data_source_id: z.string().optional(),
	investor_crm_data_source_id: z.string().optional(),
	notion_user_id: z.string().optional(),

	// --- dos, `angus` domain (ADR-054 §9) ---
	// The personal State Doc. Same key name as notionConfigSchema's, because it is the
	// same pointer for the other domain — state_doc_update resolves domain 'angus' to
	// this row. Until it is set, the `angus` domain is not merely unconfigured but
	// unrepresentable, which is why the tool's failure for it is loud (ADR-054 §6:
	// a domain that reads as present and silently writes nowhere is the defect).
	state_doc_page_id: z.string().optional(), // required for state_doc_update(domain:'angus')

	// The personal Daily Log destination (#674). Until these existed the `angus` domain
	// could write a State Doc but not a Daily Log — so a day closed only halfway and the
	// `synthesized` marker (ADR-050 §6) had no object to point at, `external_id` being
	// NOT NULL. The pointer was not merely unset, it was unstorable: integration_set
	// persists the raw merged object while loadIntegrationConfig returns the zod-PARSED
	// one, and z.object strips unknown keys rather than erroring — so wiring a key this
	// schema does not declare reports success and is then invisible to every reader,
	// including notion_config_get's own `raw:` line. Same names as notionConfigSchema's
	// so one per-domain lookup serves both; same database/data-source split as the
	// meeting_notes_* and people_* pairs.
	daily_log_database_id: z.string().optional(), // the WRITE parent for daily_log_create
	daily_log_data_source_id: z.string().optional(), // the READ half: tail query + duplicate guard

	// --- capture routing destinations (#299, capture consolidation slice 4) ---
	// Where synthesis-time consumers route personal-context content (Personal Inbox
	// / Personal Resources). One user's private wiring — NEVER hardcoded in a skill
	// body or server source (ADR-018). Set via integration_set; read via
	// notion_config_get. database_id/data_source_id pairs mirror the existing
	// meeting_notes_* / people_* key pattern.
	inbox_database_id: z.string().optional(),
	inbox_data_source_id: z.string().optional(),
	resources_database_id: z.string().optional(),
	resources_data_source_id: z.string().optional(),

	// Notion automations (#546 / ADR-048). A single nested key so the addition
	// stays self-contained beside the routing keys above.
	automations: z
		.object({ completed_at_stamp: completedAtStampRuleSchema.optional() })
		.optional(),
});

export type NotionPersonalConfig = z.infer<typeof notionPersonalConfigSchema>;

export const driveWatchChannelSchema = z.object({
	id: z.string(),
	resourceId: z.string().optional(),
	resource_id: z.string().optional(),
	expiration: z.string(),
	address: z.string().optional(),
	updatedAt: z.string().optional(),
	updated_at: z.string().optional(),
	pageToken: z.string().optional(),
});

export type DriveWatchChannelConfig = z.infer<typeof driveWatchChannelSchema>;

// provider='google_drive' — Google Drive. Auth is via GOOGLE_REFRESH_TOKEN_PERSONAL env var; no secrets here.
// This row acts as a feature flag so integration_list surfaces 'google_drive'.
// Optional: default_folder_id can be used as the upload destination by drive_* tools.
// watch_channels records active changes.watch push notification channels per account (Issue #1348).
export const driveConfigSchema = z.object({
	default_folder_id: z
		.string()
		.optional()
		.describe("Drive folder ID to use as the default upload/import destination"),
	watch_channels: z
		.record(z.string(), driveWatchChannelSchema)
		.optional()
		.describe("Active Google Drive changes.watch push notification channels per account"),
});

export type DriveConfig = z.infer<typeof driveConfigSchema>;

// provider='google_calendar' — Google Calendar (issue #126, ADR-038 Act facet). Auth is
// via GOOGLE_REFRESH_TOKEN_PERSONAL env var (the same Drive-flow refresh token, re-minted with
// CALENDAR_SCOPE added — see scripts/google-oauth.ts); no secrets here. This row acts
// as a feature flag so integration_list surfaces 'google_calendar', mirroring
// driveConfigSchema's shape. calendar_id defaults to "primary" (the owner's default
// calendar) so a bare `integration_set({ provider: 'google_calendar' })` with an
// empty config still lands a usable row.
export const calendarConfigSchema = z.object({
	calendar_id: z
		.string()
		.min(1)
		.default("primary")
		.describe("Google Calendar id to create events on. Defaults to 'primary'."),
});

export type CalendarConfig = z.infer<typeof calendarConfigSchema>;

// provider='dex' — Dex personal CRM. Auth is via DEX_API_KEY env var; no secrets here.
// This row acts as a feature flag and surfaced by integration_list.
// Optional: default_tag_ids can be used by the Dex tools (dex_call_tool) to auto-tag new contacts.
export const dexConfigSchema = z.object({
	default_tag_ids: z
		.array(z.string())
		.default([])
		.describe("Tag IDs to auto-apply when creating contacts via ahkms"),
});

export type DexConfig = z.infer<typeof dexConfigSchema>;

// provider='brevo' — Brevo email marketing / CRM (the Work customer-comms stack).
// Routed via Brevo's OWN hosted MCP server (routing='mcp', ADR-055) — provider-hosted,
// so no third-party egress. Auth is via the BREVO_MCP_API_KEY env var; no secrets here.
// This row acts as a feature flag surfaced by integration_list. The optional sender
// defaults are agent hints for composing campaigns/emails, not enforced by the tools.
export const brevoConfigSchema = z.object({
	default_sender_email: z
		.string()
		.optional()
		.describe("Default sender email to suggest when composing Brevo campaigns/emails"),
	default_sender_name: z
		.string()
		.optional()
		.describe("Default sender display name to suggest when composing Brevo campaigns/emails"),
});

export type BrevoConfig = z.infer<typeof brevoConfigSchema>;

// provider='meta_ads' — Meta Marketing API, read-only (#646). Routed NATIVE
// (routing='native', ADR-032): direct Marketing API REST calls on our own system-user
// token, NOT a passthrough to an upstream MCP server — unlike Brevo (ADR-055), Meta's
// own hosted MCP (mcp.facebook.com/ads) is the interactive surface this integration
// exists to complement for headless/scheduled sessions, not proxy. Auth is via the
// META_ADS_ACCESS_TOKEN env var; no secrets here (ADR-045). This row acts as a feature
// flag surfaced by integration_list. default_ad_account_id lets a caller omit
// ad_account_id on every meta_ads_call_tool call that needs one.
export const metaAdsConfigSchema = z.object({
	default_ad_account_id: z
		.string()
		.optional()
		.describe(
			"Default Meta ad account id (e.g. 'act_123456789') used when a meta_ads_call_tool call omits ad_account_id. Discover it via meta_ads_call_tool({ name: 'list_ad_accounts' }).",
		),
});

export type MetaAdsConfig = z.infer<typeof metaAdsConfigSchema>;

// provider='linkedin' (native LinkedIn Posts API, routing='native', #1631 / #1632).
// Auth is via the LINKEDIN_ACCESS_TOKEN env var (60-day member access token scoped
// openid, profile, w_member_social); no secrets live here (ADR-045).
export const linkedinConfigSchema = z.object({
	author: z
		.string()
		.regex(/^urn:li:(person|organization):.+/, "Expected a LinkedIn URN like urn:li:person:…")
		.optional()
		.describe(
			"LinkedIn author URN (e.g. urn:li:person:5uhjZhaVNw). Auto-resolved from GET /v2/userinfo and cached on first post when omitted.",
		),
	visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
	// LinkedIn sunsets API versions roughly yearly. Bump this value in user_integrations
	// when LinkedIn returns NONEXISTENT_VERSION, with no code change. Format YYYYMM.
	linkedin_version: z
		.string()
		.regex(/^\d{6}$/, "Expected YYYYMM format, e.g. '202601'")
		.default("202601"),
});

export type LinkedinConfig = z.infer<typeof linkedinConfigSchema>;

// provider='github' — GitHub integration for issue creation and repository interactions (ADR-106).
// Non-secret wiring persisted in user_integrations: allowlisted repos and optional default repo.
// Tokens never live here — GITHUB_PERSONAL_ACCESS_TOKEN comes from env.
export const githubConfigSchema = z.object({
	issue_repos: z
		.array(
			z
				.string()
				.regex(
					/^[a-zA-Z0-9_.-]+\/(?:[a-zA-Z0-9_.-]+|\*)$/,
					"Repo must be in 'owner/repo' or 'owner/*' format",
				),
		)
		.default([])
		.describe("Allowlisted repositories for issue creation via github_issue_create ('owner/repo')"),
	read_repos: z
		.array(
			z
				.string()
				.regex(
					/^[a-zA-Z0-9_.-]+\/(?:[a-zA-Z0-9_.-]+|\*)$/,
					"Repo must be in 'owner/repo' or 'owner/*' format",
				),
		)
		.default([])
		.describe("Allowlisted repositories for GitHub read actions (ADR-106)"),
	pr_repos: z
		.array(
			z
				.string()
				.regex(
					/^[a-zA-Z0-9_.-]+\/(?:[a-zA-Z0-9_.-]+|\*)$/,
					"Repo must be in 'owner/repo' or 'owner/*' format",
				),
		)
		.default([])
		.describe("Allowlisted repositories for GitHub PR mutations (ADR-106)"),
	default_repo: z
		.string()
		.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
		.optional()
		.describe("Default GitHub repository ('owner/repo') when omitted in github_issue_create"),
});

export type GithubConfig = z.infer<typeof githubConfigSchema>;

// provider='bigquery' — Personal GCP BigQuery read-only query config (#1650).
// Auth is via GOOGLE_REFRESH_TOKEN_PERSONAL env var ('angus' domain only).
export const bigqueryConfigSchema = z.object({
	project_id: z.string().min(1),
	location: z.string().min(1).optional(),
	datasets: z
		.array(z.string().regex(/^[^.\s]+\.[^.\s]+$/, "Dataset must be in 'project.dataset' format"))
		.default([]),
	max_bytes_billed: z.number().int().positive().default(1_073_741_824),
	max_rows: z.number().int().min(1).max(1000).default(200),
});

export type BigqueryConfig = z.infer<typeof bigqueryConfigSchema>;

// Non-secret config for `whatsapp` (self-hosted Baileys linked companion device, ADR-032).
// Auth keys live on disk in the local Baileys multi-file auth directory (`~/.ahkms/whatsapp/auth`
// or `WHATSAPP_AUTH_DIR`), never in `user_integrations.config`.
export const whatsappConfigSchema = z.object({
	// Owner's own JID (e.g. '447700900000@s.whatsapp.net') used to identify "Message Yourself" self-chats.
	self_chat_jid: z.string().min(1).optional(),
	// Optional allowlist of chat JIDs ('*@s.whatsapp.net', '*@g.us') to scope reads/ingest when set.
	allowed_chat_jids: z.array(z.string().min(1)).optional(),
	// Optional blocklist of noisy chat JIDs to skip during `whatsapp_ingest`.
	excluded_chat_jids: z.array(z.string().min(1)).optional(),
	// Default `from_me_only` behaviour for `whatsapp_ingest` when the caller omits the flag.
	ingest_from_me_only: z.boolean().optional(),
	// Optional filesystem path override for the synced WhatsApp store JSON.
	store_path: z.string().min(1).optional(),
	// Optional filesystem path override for the Baileys multi-file auth directory.
	auth_dir: z.string().min(1).optional(),
});

export type WhatsappConfig = z.infer<typeof whatsappConfigSchema>;

export type IntegrationConfigResult<T> =
	| { status: "ok"; data: T }
	| { status: "unwired" }
	| { status: "error"; error: unknown };

// How a send/read tool reaches a provider behind our gateway port (ADR-032):
//   native        - thin in-house adapter, token in env (drive.ts/notion.ts pattern)
//   mcp           - a self-hosted or provider-hosted MCP server upstream
//   own_substrate - our own backend (Supabase/PostHog/Firebase): direct, never an aggregator
export type IntegrationRouting = "native" | "mcp" | "own_substrate";

export type IntegrationRow = {
	provider: string;
	routing: IntegrationRouting;
	status: string;
	enabled: boolean;
	credential_ref: string | null;
	config: Record<string, unknown>;
};

export type IntegrationSummary = {
	provider: string;
	enabled: boolean;
	routing: string;
	status: string;
	config_keys: string[];
	config?: Record<string, unknown>;
};

export const SECRET_CONFIG_KEY_PATTERN = /(?:token|secret|password|api_key|private_key)/i;

export function redactIntegrationConfig(
	config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (SECRET_CONFIG_KEY_PATTERN.test(key)) {
			out[key] = "[REDACTED]";
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			out[key] = redactIntegrationConfig(value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out;
}

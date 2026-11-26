import { parseGmailTriageMode, parseJobHuntGmailMode } from "@ahkms/core/engine";

// Scheduler config (ADR-016 Slice 3, #53). Kept separate from the main ../env.ts
// module since these vars only matter to the scheduler, not the rest of the tool
// layer, and default to "off" so running mcp-server locally never silently starts
// hitting production Drive/Supabase on a timer.

/**
 * A positive whole number from an env var, or `fallback`. Stricter than the bare
 * `Number(x ?? d)` the older settings below use, on purpose: an empty value (which the
 * .env.example template leaves) is `Number("") === 0`, and a per-run bound of 0 would
 * make every sweep list its window and fetch nothing, forever, while recording success.
 * A fraction rounds down, and anything below 1 or not a number is the fallback.
 */
export function positiveInt(raw: string | undefined, fallback: number): number {
	const n = Number(raw);
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 1
		? Math.floor(n)
		: fallback;
}

export const env = {
	// Explicit opt-in. Unset (default) or any value other than "true" -> disabled.
	// Set to "true" in the Railway prod env only.
	enabled: process.env.KMS_SCHEDULER_ENABLED === "true",
	discoverIntervalMinutes: Number(process.env.KMS_DISCOVER_INTERVAL_MINUTES ?? 1440),
	enrichIntervalMinutes: Number(process.env.KMS_ENRICH_INTERVAL_MINUTES ?? 1440),
	enrichBatchLimit: Number(process.env.KMS_ENRICH_BATCH_LIMIT ?? 25),
	// Notion automations reconciliation sweep (#546 / ADR-048). Its own explicit
	// opt-in on top of the master switch above: both must be "true" for the sweep
	// to run, so enabling the discover/enrich cadences never silently starts
	// writing to the personal Notion workspace.
	notionAutomationsEnabled: process.env.KMS_NOTION_AUTOMATIONS_ENABLED === "true",
	notionAutomationsIntervalMinutes: Number(
		process.env.KMS_NOTION_AUTOMATIONS_INTERVAL_MINUTES ?? 1440,
	),
	// Gmail automations cadence (#356). Its own explicit opt-in on top of the
	// master switch above: both must be "true" for the sweep to run, so enabling
	// discover/enrich never silently starts mutating Gmail labels.
	gmailAutomationsEnabled: process.env.KMS_GMAIL_AUTOMATIONS_ENABLED === "true",
	gmailAutomationsIntervalMinutes: Number(
		process.env.KMS_GMAIL_AUTOMATIONS_INTERVAL_MINUTES ?? 60,
	),
	// Email pipeline (ADR-118). Its own switch, on by default under the master switch,
	// because the default mode is "shadow": it judges and logs both mailboxes and leaves
	// Gmail untouched. Promote to "label" (adds ahOS/* labels) and then "act" (archives
	// what the HITL gate cleared, drafts replies, creates confident tasks) once the
	// shadow metrics look right. KMS_GMAIL_TRIAGE_ENABLED=false turns it off.
	gmailTriageEnabled: process.env.KMS_GMAIL_TRIAGE_ENABLED !== "false",
	gmailTriageMode: parseGmailTriageMode(process.env.KMS_GMAIL_TRIAGE_MODE),
	gmailTriageIntervalMinutes: positiveInt(process.env.KMS_GMAIL_TRIAGE_INTERVAL_MINUTES, 60),
	gmailTriageMaxThreads: Math.min(100, positiveInt(process.env.KMS_GMAIL_TRIAGE_MAX_THREADS, 50)),
	gmailTriageAttentionBudget: Math.min(100, positiveInt(process.env.KMS_GMAIL_TRIAGE_ATTENTION_BUDGET, 15)),
	// Job hunt personal-mailbox Gmail ingestion (ADR-120 Phase 2, #2452). Disabled by default
	// until the attended 120-day shadow backfill passes >=90% agreement; defaults to 'shadow'.
	jobHuntGmailEnabled: process.env.KMS_JOB_HUNT_GMAIL_ENABLED === "true",
	jobHuntGmailMode: parseJobHuntGmailMode(process.env.KMS_JOB_HUNT_GMAIL_MODE),
	jobHuntGmailMaxMessages: Math.min(500, positiveInt(process.env.KMS_JOB_HUNT_GMAIL_MAX_MESSAGES, 50)),
	// Gmail attachment discover connector (#1210). Not a cadence of its own: it is one
	// more connector inside the shared discover cadence, under the shared "discover"
	// lock and interval. Its own explicit opt-in on top of the master switch all the
	// same, because unlike Drive and Notion it arrives with an unswept history: the
	// first runs backfill a whole mailbox's attachments, and that should start when the
	// owner decides, not on whichever deploy happens to ship this code.
	gmailAttachmentDiscoverEnabled: process.env.KMS_GMAIL_ATTACHMENT_DISCOVER_ENABLED === "true",
	// Messages fetched per account per run. The bound is what keeps a first run over
	// years of mail from running for hours inside the shared lock. Each run sweeps the
	// mail since the last run first, then spends what is left on the history, newest
	// first, resuming from a cursor; see gmailAttachmentDiscoverCadence.ts.
	gmailAttachmentDiscoverMaxMessages: positiveInt(
		process.env.KMS_GMAIL_ATTACHMENT_DISCOVER_MAX_MESSAGES,
		1000,
	),
	// Drive hygiene Band 1 self-heal + weekly KPI snapshot cadence (ADR-115 Stage 7A).
	// Enabled by default whenever the master KMS_SCHEDULER_ENABLED switch is on so
	// Railway production runs zero-HITL self-healing every 6 hours without manual
	// env-var intervention; set KMS_DRIVE_HYGIENE_ENABLED=false to disable.
	driveHygieneEnabled: process.env.KMS_DRIVE_HYGIENE_ENABLED !== "false",
	driveHygieneIntervalMinutes: positiveInt(
		process.env.KMS_DRIVE_HYGIENE_INTERVAL_MINUTES,
		360,
	),
	driveHygieneMaxActions: Math.min(
		500,
		positiveInt(process.env.KMS_DRIVE_HYGIENE_MAX_ACTIONS, 500),
	),
};

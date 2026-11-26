import { ARTIFACT_SURFACES } from "@ahkms/shared";
import { effectiveSurfaceRoleMap, loadCapturePreferences } from "../captureConfig.js";
import { GMAIL_INGEST_SURFACE } from "../vocab.js";
import { DOMAINS, DOMAIN_PROVIDER, type Domain } from "../domains.js";
import { quarantinedValues, hasDrift, unverifiedVocabularies, propertyDriftFindings } from "../dosConfigDrift.js";
import {
	driveConfigSchema,
	githubConfigSchema,
	listIntegrations,
	loadIntegrationConfigDetailed,
	notionConfigSchema,
	notionPersonalConfigSchema,
	type IntegrationSummary,
} from "../integrations.js";
import { loadDosConfigDetailed, reconcileDomainAgainstNotion, type TasksDriftReport } from "@ahkms/core";
import {
	createSupabaseConfigRepository,
	type ConfigSupabaseClient,
} from "@ahkms/core/adapters";
import type { DoctorCheck } from "./report.js";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { notionAdapter } from "../tools/searchNotion.js";
import { approvalChecks } from "./approvalChecks.js";
import { ledgerChecks } from "./ledgerChecks.js";

// ahos_doctor, family 2: wiring, not just secrets (#1024).
//
// A secret that works is half the answer; the other half is whether the non-secret
// pointers route anything anywhere. Every read here already exists and is reused:
// `listIntegrations` (integration_list), `loadCapturePreferences` (config_capture_get),
// and `reconcileDomainAgainstNotion` — the structured core of dos_config_drift, which is
// both the Daily Log option reconciliation and the #1001 tasks property_map check.

/** The Notion rows the dos ritual cannot run without. */
const REQUIRED_PROVIDERS = ["notion_work", "notion_personal"] as const;

/**
 * Per-domain keys dos Setup read 2 names as required (.claude/skills/dos/SKILL.md).
 * Kept here, next to the check, rather than derived from the schemas: the schemas mark
 * them optional because non-dos tools do not need them.
 */
const DOS_POINTERS: Record<(typeof REQUIRED_PROVIDERS)[number], string[]> = {
	notion_work: [
		"state_doc_page_id",
		"tasks_source_data_source_id",
		"meetings_source_data_source_id",
		"investor_crm_data_source_id",
		"notion_user_id",
	],
	notion_personal: ["state_doc_page_id"],
};

const SCHEMA_KEYS: Record<(typeof REQUIRED_PROVIDERS)[number], Set<string>> = {
	notion_work: new Set(Object.keys(notionConfigSchema.shape)),
	notion_personal: new Set(Object.keys(notionPersonalConfigSchema.shape)),
};

/**
 * Bulk machine-ingest surfaces. Each lands at `default_role` (normally `narrative`)
 * unless the effective map names it, which is how a day of GitHub activity floods the
 * day-window read (#567). Since #1767 the shipped DISCOVER_ROLE_SEED floors all four, so
 * on a healthy build this check is green by construction; it stays as the guard for a
 * bulk surface added to this list without a floor entry. The Drive discover surfaces are
 * absent on purpose: the seed has floored them since #570. The suggested role is
 * ADR-046 §3/§4's tiering for that kind of source.
 */
const BULK_SURFACES: { surface: string; suggested: string }[] = [
	{ surface: ARTIFACT_SURFACES.actReceipt, suggested: "evidence" },
	{ surface: ARTIFACT_SURFACES.github, suggested: "evidence" },
	{ surface: ARTIFACT_SURFACES.slack, suggested: "evidence" },
	{ surface: ARTIFACT_SURFACES.slackDm, suggested: "evidence" },
	{ surface: ARTIFACT_SURFACES.whatsapp, suggested: "evidence" },
	{ surface: ARTIFACT_SURFACES.whatsappDm, suggested: "evidence" },
	{ surface: ARTIFACT_SURFACES.derived, suggested: "evidence" },
	{ surface: GMAIL_INGEST_SURFACE, suggested: "evidence" },
];

const wire = (provider: string) =>
	`integration_set({ provider: '${provider}', config: { <key>: '<id>' } }) — the ids come from the Notion page/database URL`;

function integrationChecks(rows: IntegrationSummary[]): DoctorCheck[] {
	const checks: DoctorCheck[] = [];
	const byProvider = new Map(rows.map((r) => [r.provider, r]));

	for (const provider of REQUIRED_PROVIDERS) {
		const r = byProvider.get(provider);
		if (!r) {
			checks.push({
				family: "wiring",
				name: `integration ${provider}`,
				status: "fail",
				detail: "no user_integrations row; every tool that routes to this workspace has nowhere to go",
				fix: `integration_set({ provider: '${provider}', config: { tasks_database_id: '<id>', state_doc_page_id: '<id>' } })`,
			});
			continue;
		}

		const missing = DOS_POINTERS[provider].filter((k) => !r.config_keys.includes(k));
		const domain = provider === "notion_work" ? "work" : "angus";
		checks.push(
			missing.length > 0
				? {
						family: "wiring",
						name: `dos pointers ${domain}`,
						status: "fail",
						detail: `${provider} is missing ${missing.join(", ")}; dos treats the ${domain} domain as unwired and routes nothing to it`,
						fix: wire(provider),
					}
				: { family: "wiring", name: `dos pointers ${domain}`, status: "ok", detail: `every pointer dos needs is set on ${provider}.`, fix: "" },
		);

		// A key the schema does not declare is stored by integration_set and then stripped
		// by every reader's zod parse: it reports success and does nothing.
		const other = provider === "notion_work" ? "notion_personal" : "notion_work";
		const unknown = r.config_keys.filter((k) => !SCHEMA_KEYS[provider].has(k) && k !== "automations");
		if (unknown.length > 0) {
			const misfiled = unknown.filter((k) => SCHEMA_KEYS[other].has(k));
			checks.push({
				family: "wiring",
				name: `config keys ${provider}`,
				status: "warn",
				detail:
					`${unknown.join(", ")} stored but not in the ${provider} schema, so every reader drops them` +
					(misfiled.length > 0 ? `; ${misfiled.join(", ")} belong${misfiled.length === 1 ? "s" : ""} on ${other}` : ""),
				fix: `move the value(s) to the provider whose schema declares them with integration_set, then remove the stray key${unknown.length === 1 ? "" : "s"} from ${provider}`,
			});
		}
	}

	for (const r of rows) {
		if (r.enabled && r.status === "connected") continue;
		checks.push({
			family: "wiring",
			name: `integration ${r.provider}`,
			status: "warn",
			detail: `row is ${r.enabled ? "" : "disabled, "}status '${r.status}'`,
			fix: `re-enable or reconnect it with integration_set({ provider: '${r.provider}', ... }), or delete the row if it is retired`,
		});
	}

	const github = byProvider.get("github");
	if (!github) {
		checks.push({
			family: "wiring",
			name: "integration github",
			status: "warn",
			detail: "no user_integrations row; github_issue_create is disabled and cannot report protocol defects",
			fix: "integration_set({ provider: 'github', config: { issue_repos: ['anguspersonal/ahOS'], default_repo: 'anguspersonal/ahOS' } })",
		});
	} else if (!github.config_keys.includes("issue_repos")) {
		checks.push({
			family: "wiring",
			name: "integration github",
			status: "warn",
			detail: "row has no issue_repos configured; github_issue_create cannot route to any repository",
			fix: "integration_set({ provider: 'github', config: { issue_repos: ['anguspersonal/ahOS'], default_repo: 'anguspersonal/ahOS' } })",
		});
	} else if (github.enabled && github.status === "connected") {
		checks.push({
			family: "wiring",
			name: "integration github",
			status: "ok",
			detail: "github integration is configured with allowlisted issue_repos.",
			fix: "",
		});
	}

	if (github) {
		const knownGithub = new Set(Object.keys(githubConfigSchema.shape));
		const unknownGithub = github.config_keys.filter((k) => !knownGithub.has(k));
		if (unknownGithub.length > 0) {
			checks.push({
				family: "wiring",
				name: "config keys github",
				status: "warn",
				detail: `${unknownGithub.join(", ")} stored but not in the github schema`,
				fix: `remove unknown keys from github with integration_set`,
			});
		}
	}

	const slack = byProvider.get("slack");
	if (!slack || !slack.enabled || !slack.config_keys.includes("owner_user_id")) {
		checks.push({
			family: "wiring",
			name: "approval cards",
			status: "warn",
			detail: "approval cards off: no slack owner_user_id",
			fix: "integration_set({ provider: 'slack', config: { owner_user_id: '<U...>' } })",
		});
	} else {
		checks.push({
			family: "wiring",
			name: "approval cards",
			status: "ok",
			detail: "approval cards on: slack owner_user_id is configured.",
			fix: "",
		});
	}

	return checks;
}

async function surfaceRoleChecks(): Promise<DoctorCheck[]> {
	const prefs = await loadCapturePreferences();
	const map = effectiveSurfaceRoleMap(prefs);
	const unmapped = BULK_SURFACES.filter(({ surface }) => !map[surface]);
	if (unmapped.length === 0) {
		return [{ family: "wiring", name: "surface_role_map", status: "ok", detail: "every bulk-ingest surface has an explicit role.", fix: "" }];
	}
	return unmapped.map(({ surface, suggested }) => ({
		family: "wiring",
		name: `surface_role_map ${surface}`,
		status: "warn",
		detail: `no entry, so '${surface}' rows resolve to default_role '${prefs.default_role}' and can flood the day-window synthesis read (#567)`,
		fix: `add '${surface}' to MACHINE_INGEST_SURFACES in packages/mcp-server/src/captureConfig.ts so the shipped floor carries it as "${suggested}" (ADR-046 §3, #1767); an owner override per key still goes in surface_role_map`,
	}));
}

function tasksCheck(domain: Domain, tasks: TasksDriftReport): DoctorCheck {
	const name = `tasks property_map ${domain}`;
	const fix = `integration_set({ provider: '${tasks.provider}', config: { property_map: { ... } } }); see dos_config_drift({ domain: '${domain}' }) for the live property names`;
	switch (tasks.status) {
		case "not_configured":
			return { family: "wiring", name, status: "ok", detail: "no tasks integration configured; a domain need not use task_create.", fix: "" };
		case "could_not_verify":
			return { family: "wiring", name, status: "warn", detail: `could not read the Tasks DB: ${tasks.error}`, fix: "re-run; if it persists, check the Tasks DB is shared with the integration" };
		case "empty_map":
			return { family: "wiring", name, status: "fail", detail: "property_map is empty; task_create guesses every property name and fails on the first wrong guess (#1001)", fix };
		case "checked": {
			const missing = tasks.findings.filter((f) => f.status === "mapped_missing");
			return missing.length > 0
				? { family: "wiring", name, status: "fail", detail: `mapped but absent on the Tasks DB: ${missing.map((f) => `${f.abstractKey} → "${f.mappedName}"`).join(", ")}`, fix }
				: { family: "wiring", name, status: "ok", detail: "every mapped property exists on the Tasks DB.", fix: "" };
		}
	}
}

async function notionOptionChecks(domain: Domain): Promise<DoctorCheck[]> {
	const name = `notion options ${domain}`;
	const provider = DOMAIN_PROVIDER[domain];
	const config = createSupabaseConfigRepository({
		client: supabase as unknown as ConfigSupabaseClient,
		ownerId: getCurrentUserId,
	});
	try {
		const result = await reconcileDomainAgainstNotion(domain, {
			notion: notionAdapter,
			config,
		});
		if (result.kind === "unconfigured") {
			// "No block" is also what a stored-but-unparseable config looks like from here,
			// and the remedies are opposite: adding a block that already exists fixes
			// nothing (#2256). Ask the loader which it is before advising. If that read
			// itself fails, fall through to the missing-block report.
			const load = await loadDosConfigDetailed(config).catch(() => null);
			if (load?.status === "unparseable") {
				return [
					{
						family: "wiring",
						name,
						status: "fail",
						detail: `dos config is stored but unparseable, so every domain reads as unconfigured; dos writes nothing. Validation issues: ${load.issues.join("; ") || "(none reported)"}`,
						fix: "correct the value at each issue path in user_preferences.dos_config (config_preferences_update); the domain blocks are most likely present, so do not add them again",
					},
				];
			}
			return [
				{
					family: "wiring",
					name,
					status: "fail",
					detail: `no dos config block for '${domain}' (present: ${result.domainsPresent.join(", ") || "none"}); dos writes nothing to this domain`,
					fix: `add a by_domain.${domain} block to user_preferences.dos_config in a migration file`,
				},
			];
		}
		if (result.kind === "target_unresolved") {
			return [
				{ family: "wiring", name, status: "warn", detail: `could not resolve the Daily Log target: ${result.error}`, fix: "re-run; a read error says nothing about config" },
			];
		}
		const tasks = tasksCheck(domain, result.tasks);
		if (result.kind === "could_not_verify") {
			return [
				{ family: "wiring", name, status: "warn", detail: `could not read the Daily Log schema: ${result.error}`, fix: "re-run; a non-404 failure says nothing about config" },
				tasks,
			];
		}
		const unverified = unverifiedVocabularies(result.report).map((v) => v.vocabulary);
		const propDrift = propertyDriftFindings(result.report);
		const quarantined = quarantinedValues(result.report);
		const options: DoctorCheck = hasDrift(result.report) || propDrift.length > 0
			? {
					family: "wiring",
					name,
					status: "fail",
					detail: [
						quarantined.length > 0 ? `configured values Notion does not offer: ${quarantined.join(", ")}` : null,
						propDrift.length > 0 ? `schema property defects: ${propDrift.map((p) => p.detail).join("; ")}` : null,
					]
						.filter(Boolean)
						.join("; "),
					fix:
						propDrift.length > 0 && quarantined.length === 0
							? propDrift.map((p) => p.remediation).filter(Boolean).join("; ")
							: "bring dos_config into line in a migration; never add the option to Notion to match stale config",
				}
			: unverified.length > 0
				? {
						family: "wiring",
						name,
						status: "warn",
						detail: `${unverified.join(", ")} reconciled against nothing: the property has no options (or none is declared), so Notion CREATES any value written (#695)`,
						fix: `define the options on the Daily Log property in Notion (${provider} workspace), or declare the property in dos_config's daily_log_schema`,
					}
				: { family: "wiring", name, status: "ok", detail: "every configured topic and pillar is a live Notion option.", fix: "" };
		return [options, tasks];
	} catch (err) {
		return [
			{
				family: "wiring",
				name,
				status: "fail",
				detail: err instanceof Error ? err.message : String(err),
				fix: `share the ${domain} Daily Log with the ${provider} Notion integration, or wire daily_log_database_id with integration_set`,
			},
		];
	}
}

export const REQUIRED_SERVER_RPCS = [
	"merge_entities",
	"unmerge_entities",
	"document_duplicate_clusters",
	"discover_envelope_refresh",
	"document_title_candidates",
	"fts_search_artifacts",
	"fts_search_entities",
	"fts_search_people",
	"hybrid_search_artifacts",
	"hybrid_search_entities",
	"hybrid_search_people",
	"search_unconsumed_artifacts",
	"get_dos_evidence_aggregate",
	"get_dos_coverage_days",
	"get_hot_tier_candidates",
] as const;

export async function rpcWiringChecks(): Promise<DoctorCheck[]> {
	const supabaseUrl = process.env.SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
	if (!supabaseUrl || !serviceKey) {
		return [
			{
				family: "wiring",
				name: "database rpc schema",
				status: "warn",
				detail: "SUPABASE_URL or API key missing; cannot inspect PostgREST schema cache.",
				fix: "set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment",
			},
		];
	}

	try {
		const res = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/`, {
			headers: {
				apikey: serviceKey,
				Authorization: `Bearer ${serviceKey}`,
			},
		});
		if (!res.ok) {
			return [
				{
					family: "wiring",
					name: "database rpc schema",
					status: "warn",
					detail: `PostgREST schema discovery returned HTTP ${res.status}: ${res.statusText}`,
					fix: "verify database connectivity and API key",
				},
			];
		}
		const doc = (await res.json()) as { paths?: Record<string, unknown> };
		const paths = doc.paths || {};
		const liveRpcs = new Set(
			Object.keys(paths)
				.filter((p) => p.startsWith("/rpc/"))
				.map((p) => p.replace("/rpc/", "")),
		);

		const missing = REQUIRED_SERVER_RPCS.filter((rpc) => !liveRpcs.has(rpc));
		if (missing.length === 0) {
			return [
				{
					family: "wiring",
					name: "database rpc schema",
					status: "ok",
					detail: `all ${REQUIRED_SERVER_RPCS.length} required server RPCs exist in live PostgREST schema cache.`,
					fix: "",
				},
			];
		}

		return missing.map((rpc) => ({
			family: "wiring",
			name: `database rpc ${rpc}`,
			status: "fail",
			detail: `RPC '${rpc}' is called by the server but missing from the live PostgREST schema cache`,
			fix: "run `supabase db push` from main to apply pending migrations, or reload the PostgREST schema cache",
		}));
	} catch (err) {
		return [
			{
				family: "wiring",
				name: "database rpc schema",
				status: "warn",
				detail: `could not query PostgREST OpenAPI schema: ${err instanceof Error ? err.message : String(err)}`,
				fix: "verify Supabase network connectivity",
			},
		];
	}
}

export async function driveWatchWiringChecks(rows: IntegrationSummary[]): Promise<DoctorCheck[]> {
	const driveRow = rows.find((r) => r.provider === "google_drive");
	if (!driveRow || !driveRow.enabled) return [];

	const detailed = await loadIntegrationConfigDetailed("google_drive", driveConfigSchema);
	if (detailed.status === "error") {
		return [
			{
				family: "wiring",
				name: "drive watch channels",
				status: "warn",
				detail: `could not read google_drive configuration: ${String(detailed.error)}`,
				fix: "verify database connectivity",
			},
		];
	}

	const configData = detailed.status === "ok" ? detailed.data : null;
	const watchChannels = configData?.watch_channels ?? {};

	const accounts: string[] = [];
	if (process.env.GOOGLE_REFRESH_TOKEN_PERSONAL || process.env.GOOGLE_REFRESH_TOKEN) {
		accounts.push("personal");
	}
	if (process.env.GOOGLE_REFRESH_TOKEN_WORK) {
		accounts.push("work");
	}
	if (accounts.length === 0) {
		accounts.push("personal");
	}

	const checks: DoctorCheck[] = [];
	const now = Date.now();

	for (const account of accounts) {
		const chan = watchChannels[account];
		const name = `drive watch ${account}`;
		if (!chan) {
			checks.push({
				family: "wiring",
				name,
				status: "warn",
				detail: `no active changes.watch channel registered for account '${account}'; /webhooks/drive is inert and falling back to 15-minute polling`,
				fix: "run the engine drive-watch cadence or trigger channel registration (requires MCP_PUBLIC_URL and DRIVE_WEBHOOK_TOKEN)",
			});
			continue;
		}

		const exp = Number(chan.expiration) || new Date(chan.expiration).getTime();
		if (isNaN(exp) || exp <= now) {
			const expIso = !isNaN(exp) ? new Date(exp).toISOString() : String(chan.expiration);
			checks.push({
				family: "wiring",
				name,
				status: "warn",
				detail: `changes.watch channel '${chan.id}' for account '${account}' expired at ${expIso}; fallback to 15-minute polling is active`,
				fix: "run the engine drive-watch cadence to renew the channel",
			});
		} else {
			checks.push({
				family: "wiring",
				name,
				status: "ok",
				detail: `active changes.watch channel '${chan.id}' registered until ${new Date(exp).toISOString()}.`,
				fix: "",
			});
		}
	}

	return checks;
}

/**
 * All cadences registered across scheduler migrations (073, 082, 084, 103, 117, 127, 131).
 * If a cadence is defined in code or schema but has 0 recorded runs in scheduler_runs,
 * ahos_doctor flags it as dormant so missing host environment gates can be surfaced early (#1754).
 */
export const DEFINED_SCHEDULER_CADENCES = [
	"alerts",
	"dedup",
	"derive",
	"discover",
	"drive-watch",
	"enrich",
	"gmail_automations",
	"jobs",
	"learning",
	"notion_automations",
] as const;

export type SchedulerCadence = (typeof DEFINED_SCHEDULER_CADENCES)[number];

export function cadenceFix(cadence: string): string {
	const envVar =
		cadence === "alerts"
			? "KMS_ALERT_EVALUATOR_ENABLED"
			: cadence === "dedup"
				? "KMS_DEDUP_SWEEP_ENABLED"
				: cadence === "discover" || cadence === "enrich"
					? "KMS_SCHEDULER_ENABLED"
					: cadence === "notion_automations"
						? "KMS_NOTION_AUTOMATIONS_ENABLED"
						: cadence === "gmail_automations"
							? "KMS_GMAIL_AUTOMATIONS_ENABLED"
							: cadence === "learning"
								? "KMS_LEARNING_SWEEP_ENABLED"
								: `KMS_${cadence.toUpperCase().replace(/-/g, "_")}_ENABLED`;
	return `verify host environment variables on worker or mcp-server (e.g. ${envVar})`;
}

/**
 * One bounded read per defined cadence (#2320), never one read of the whole table: the API
 * caps a response at `max_rows` (`supabase/config.toml`), and `scheduler_runs` gains a row
 * per run, so an unfiltered select returns an arbitrary 1000 rows and every cadence outside
 * them looks as if it never ran. Each read is served by the `(cadence, started_at desc)` index.
 */
export async function schedulerCadenceChecks(client = supabase): Promise<DoctorCheck[]> {
	try {
		const reads = await Promise.all(
			DEFINED_SCHEDULER_CADENCES.map(async (cadence) => {
				const { data, error } = await client.from("scheduler_runs").select("cadence").eq("cadence", cadence).limit(1);
				return { cadence, error, hasRun: (data ?? []).length > 0 };
			}),
		);
		// A cadence that could not be read is unknown, not dormant: report the failure alone.
		const failed = reads.find((read) => read.error);
		if (failed?.error) {
			return [
				{
					family: "wiring",
					name: "scheduler cadences",
					status: "warn",
					detail: `could not query scheduler_runs: ${failed.error.message}`,
					fix: "verify Supabase network connectivity and scheduler_runs permissions",
				},
			];
		}

		const dormant = reads.filter((read) => !read.hasRun).map((read) => read.cadence);

		if (dormant.length === 0) {
			return [
				{
					family: "wiring",
					name: "scheduler cadences",
					status: "ok",
					detail: `all ${DEFINED_SCHEDULER_CADENCES.length} defined scheduler cadences have recorded runs in scheduler_runs.`,
					fix: "",
				},
			];
		}

		return dormant.map((cadence) => ({
			family: "wiring",
			name: `scheduler cadence ${cadence}`,
			status: "warn",
			detail: `cadence '${cadence}' is defined in code but has never recorded a run in scheduler_runs; cadence may be inert or missing env gate`,
			fix: cadenceFix(cadence),
		}));
	} catch (err) {
		return [
			{
				family: "wiring",
				name: "scheduler cadences",
				status: "warn",
				detail: `could not query scheduler_runs: ${err instanceof Error ? err.message : String(err)}`,
				fix: "verify Supabase network connectivity and scheduler_runs permissions",
			},
		];
	}
}

export async function checkWiring(): Promise<DoctorCheck[]> {
	const [rows, roles, notionChecks, rpcChecks] = await Promise.all([
		listIntegrations(),
		surfaceRoleChecks().catch((err): DoctorCheck[] => [
			{ family: "wiring", name: "surface_role_map", status: "warn", detail: `could not read capture preferences: ${err instanceof Error ? err.message : String(err)}`, fix: "check config_capture_get" },
		]),
		Promise.all(DOMAINS.map(notionOptionChecks)),
		rpcWiringChecks(),
	]);
	const driveChecks = await driveWatchWiringChecks(rows).catch((err): DoctorCheck[] => [
		{ family: "wiring", name: "drive watch channels", status: "warn", detail: `could not check drive watch channels: ${err instanceof Error ? err.message : String(err)}`, fix: "check database connectivity" },
	]);
	const cadenceChecks = await schedulerCadenceChecks().catch((err): DoctorCheck[] => [
		{ family: "wiring", name: "scheduler cadences", status: "warn", detail: `could not check scheduler cadences: ${err instanceof Error ? err.message : String(err)}`, fix: "verify Supabase connectivity" },
	]);
	const ledger = await ledgerChecks().catch((err): DoctorCheck[] => [
		{
			family: "wiring",
			name: "action ledger",
			status: "fail",
			detail: `could not check action ledger: ${err instanceof Error ? err.message : String(err)}`,
			fix: "verify action_ledger table and Supabase connectivity",
		},
	]);
	const approvals = await approvalChecks().catch((err): DoctorCheck[] => [
		{
			family: "wiring",
			name: "stuck action approvals",
			status: "warn",
			detail: `could not check stuck action approvals: ${err instanceof Error ? err.message : String(err)}`,
			fix: "verify system_decisions table and Supabase connectivity",
		},
	]);
	return [...integrationChecks(rows), ...roles, ...notionChecks.flat(), ...rpcChecks, ...driveChecks, ...cadenceChecks, ...ledger, ...approvals];
}

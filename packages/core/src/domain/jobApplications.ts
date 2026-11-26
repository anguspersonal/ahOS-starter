// Job Applications Domain Contract (ADR-120, #2439).
// Isomorphic and browser-safe: zero Node imports.

import type { PriorityLevel } from "./priorityScale.js";
import type {
	DimensionTerm,
	TaskEnergyModeSlug,
	TaskSourceSlug,
	TaskStatusSlug,
} from "./taskDimensions.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reification discriminator (`entities.properties.kind`) for job application
 * `arrangement` nodes (ADR-035 §4, ADR-120 §1).
 */
export const JOB_APPLICATION_ENTITY_KIND = "job_application" as const;

/** Default PARA containment area title and locked domain override (ADR-120 §4). */
export const JOB_SEARCH_AREA_TITLE = "Job Search" as const;
export const JOB_SEARCH_DOMAIN = "angus" as const;

/**
 * Five `ahos:`-native participant edge types minted in `EDGE_TYPES` (ADR-120 §2)
 * plus the optional tracked-CV `references` edge (ADR-098, ADR-120 §7).
 */
export const JOB_APPLICATION_PARTICIPANT_EDGES = [
	"applicant",
	"applied_to",
	"applied_via",
	"recruiter",
	"hiring_contact",
] as const;
export type JobApplicationParticipantEdge =
	(typeof JOB_APPLICATION_PARTICIPANT_EDGES)[number];

export const JOB_APPLICATION_CV_EDGE = "references" as const;

/**
 * Aliases forbidden on the `Dex jobs` (`meetdex.ai`) organisation entity so it
 * can never collide with the Dex CRM (`getdex.com`) integration (ADR-120 §4).
 */
export const DEX_JOBS_ALIAS_DENYLIST = ["dex", "getdex", "getdex.com"] as const;

/** Check whether a candidate alias collides with the forbidden Dex CRM terms. */
export function isForbiddenDexJobsAlias(alias: string): boolean {
	const normalized = alias.trim().toLowerCase();
	if (!normalized) return false;
	return (DEX_JOBS_ALIAS_DENYLIST as readonly string[]).includes(normalized);
}

// ---------------------------------------------------------------------------
// 1. Stage Vocabulary (11 stages, ADR-120 §3) & statusForStage (ADR-117)
// ---------------------------------------------------------------------------

export const JOB_APPLICATION_STAGE_SLUGS = [
	"identified",
	"matched",
	"drafting",
	"applied",
	"screening",
	"interviewing",
	"offer",
	"accepted",
	"rejected",
	"withdrawn",
	"closed_no_reply",
] as const;

export type JobApplicationStage = (typeof JOB_APPLICATION_STAGE_SLUGS)[number];

export interface JobApplicationStageDefinition
	extends DimensionTerm<JobApplicationStage> {
	terminal: boolean;
	submitted: boolean | "conditional";
}

export const JOB_APPLICATION_STAGES: readonly JobApplicationStageDefinition[] =
	[
		{
			id: 1,
			slug: "identified",
			display: "Identified",
			meaning:
				"Self-found or saved role; owner has not yet decided whether to apply.",
			terminal: false,
			submitted: false,
		},
		{
			id: 2,
			slug: "matched",
			display: "Matched",
			meaning:
				"Suggested by a platform, recruiter, or agent; owner has not yet decided whether to apply.",
			terminal: false,
			submitted: false,
		},
		{
			id: 3,
			slug: "drafting",
			display: "Drafting",
			meaning: "Owner started an application and has not submitted it yet.",
			terminal: false,
			submitted: false,
		},
		{
			id: 4,
			slug: "applied",
			display: "Applied",
			meaning: "Submitted; awaiting human response.",
			terminal: false,
			submitted: true,
		},
		{
			id: 5,
			slug: "screening",
			display: "Screening",
			meaning: "A first call is offered, booked, or held.",
			terminal: false,
			submitted: true,
		},
		{
			id: 6,
			slug: "interviewing",
			display: "Interviewing",
			meaning: "Past the first call: further rounds, tasks, or panels.",
			terminal: false,
			submitted: true,
		},
		{
			id: 7,
			slug: "offer",
			display: "Offer",
			meaning: "An offer is on the table.",
			terminal: false,
			submitted: true,
		},
		{
			id: 8,
			slug: "accepted",
			display: "Accepted",
			meaning: "The owner accepted the offer.",
			terminal: true,
			submitted: true,
		},
		{
			id: 9,
			slug: "rejected",
			display: "Rejected",
			meaning: "The organisation declined, at any point.",
			terminal: true,
			submitted: true,
		},
		{
			id: 10,
			slug: "withdrawn",
			display: "Withdrawn",
			meaning:
				"The owner declined or dropped the role. Counts as submitted only if applied_on is set.",
			terminal: true,
			submitted: "conditional",
		},
		{
			id: 11,
			slug: "closed_no_reply",
			display: "Closed, no reply",
			meaning:
				"Closed after prolonged silence (manual close or 42-day auto-close).",
			terminal: true,
			submitted: true,
		},
	] as const;

const STAGE_TO_STATUS: Record<JobApplicationStage, TaskStatusSlug> = {
	identified: "proposed",
	matched: "proposed",
	drafting: "todo",
	applied: "in_progress",
	screening: "in_progress",
	interviewing: "in_progress",
	offer: "in_progress",
	accepted: "done",
	rejected: "cancelled",
	withdrawn: "cancelled",
	closed_no_reply: "cancelled",
};

const INTERVIEW_REACHED_STAGES: ReadonlySet<JobApplicationStage> = new Set([
	"screening",
	"interviewing",
	"offer",
	"accepted",
]);

/** Type guard for the 11 canonical ADR-120 job-application stages. */
export function isJobApplicationStage(
	value: unknown,
): value is JobApplicationStage {
	return (
		typeof value === "string" &&
		(JOB_APPLICATION_STAGE_SLUGS as readonly string[]).includes(value)
	);
}

/** Look up the stage metadata term for a validated stage slug. */
export function getJobApplicationStageDefinition(
	stage: JobApplicationStage,
): JobApplicationStageDefinition {
	const found = JOB_APPLICATION_STAGES.find((s) => s.slug === stage);
	if (!found) {
		throw new Error(`Invalid job application stage: ${String(stage)}`);
	}
	return found;
}

/** Map a job-application stage deterministically to its ADR-117 task status. */
export function statusForStage(stage: JobApplicationStage): TaskStatusSlug {
	return STAGE_TO_STATUS[stage];
}

/** True when a stage is terminal (`accepted`, `rejected`, `withdrawn`, `closed_no_reply`). */
export function isTerminalStage(stage: JobApplicationStage): boolean {
	return getJobApplicationStageDefinition(stage).terminal;
}

/** True when a stage sits in the pre-application decision queue (`identified` or `matched`). */
export function isToReviewStage(stage: JobApplicationStage): boolean {
	return stage === "identified" || stage === "matched";
}

// ---------------------------------------------------------------------------
// 2. Role Categories (6 terms, ADR-120 §5 / #2439 Locked Decision 3)
// ---------------------------------------------------------------------------

export const ROLE_CATEGORY_SLUGS = [
	"product",
	"ai_engineering",
	"data_leadership",
	"ops_chief_of_staff",
	"solutions",
	"other",
] as const;

export type RoleCategory = (typeof ROLE_CATEGORY_SLUGS)[number];

export const ROLE_CATEGORIES: readonly DimensionTerm<RoleCategory>[] = [
	{
		id: 1,
		slug: "product",
		display: "Product",
		meaning:
			"Founding product lead, product engineer, head of product: roles combining building and product judgement.",
	},
	{
		id: 2,
		slug: "ai_engineering",
		display: "AI Engineering",
		meaning:
			"Engineering roles screened mainly on engineering depth: applied AI engineer, founding engineer, forward deployed engineer.",
	},
	{
		id: 3,
		slug: "data_leadership",
		display: "Data Leadership",
		meaning:
			"Head of data, data strategy director, and similar leadership roles in data.",
	},
	{
		id: 4,
		slug: "ops_chief_of_staff",
		display: "Ops / Chief of Staff",
		meaning: "Chief of staff, special projects, operations, and automation.",
	},
	{
		id: 5,
		slug: "solutions",
		display: "Solutions",
		meaning:
			"Solutions engineer, AI solutions lead, and similar customer-facing technical roles.",
	},
	{
		id: 6,
		slug: "other",
		display: "Other",
		meaning: "Fellowships, programmes, and any role outside the core categories.",
	},
] as const;

/** Type guard for the 6 canonical ADR-120 role categories. */
export function isRoleCategory(value: unknown): value is RoleCategory {
	return (
		typeof value === "string" &&
		(ROLE_CATEGORY_SLUGS as readonly string[]).includes(value)
	);
}

/** Look up the DimensionTerm metadata for a role category. */
export function getRoleCategoryTerm(
	category: RoleCategory,
): DimensionTerm<RoleCategory> {
	const found = ROLE_CATEGORIES.find((c) => c.slug === category);
	if (!found) {
		throw new Error(`Invalid role category: ${String(category)}`);
	}
	return found;
}

// ---------------------------------------------------------------------------
// 3. Channels & Job-Site Channel Kinds (ADR-120 §5)
// ---------------------------------------------------------------------------

export const APPLICATION_CHANNEL_SLUGS = [
	"jumpstart",
	"cord",
	"dex_jobs",
	"jack_and_jill",
	"company_site",
	"recruiter",
	"referral",
	"direct_outreach",
] as const;

export type ApplicationChannel = (typeof APPLICATION_CHANNEL_SLUGS)[number];

export const APPLICATION_CHANNELS: readonly DimensionTerm<ApplicationChannel>[] =
	[
		{
			id: 1,
			slug: "jumpstart",
			display: "Jumpstart",
			meaning: "Curated matchmaker cohort and introductions via Jumpstart.",
		},
		{
			id: 2,
			slug: "cord",
			display: "Cord",
			meaning: "Direct messaging and applications via Cord.",
		},
		{
			id: 3,
			slug: "dex_jobs",
			display: "Dex jobs",
			meaning: "Applications routed through Dex jobs (meetdex.ai).",
		},
		{
			id: 4,
			slug: "jack_and_jill",
			display: "Jack & Jill",
			meaning: "AI-recruiter role matches from Jack & Jill.",
		},
		{
			id: 5,
			slug: "company_site",
			display: "Company site",
			meaning: "Direct submission on a company career site or ATS portal.",
		},
		{
			id: 6,
			slug: "recruiter",
			display: "Recruiter",
			meaning: "External recruiting agency or headhunter representation.",
		},
		{
			id: 7,
			slug: "referral",
			display: "Referral",
			meaning: "Warm introduction or employee referral.",
		},
		{
			id: 8,
			slug: "direct_outreach",
			display: "Direct outreach",
			meaning: "Cold or direct founder/hiring-manager outreach.",
		},
	] as const;

export const JOB_SITE_CHANNEL_KINDS = [
	"matchmaker",
	"marketplace",
	"ai_recruiter",
	"agency",
	"direct_outreach",
] as const;

export type JobSiteChannelKind = (typeof JOB_SITE_CHANNEL_KINDS)[number];

/** Type guard for application channel slugs. */
export function isApplicationChannel(
	value: unknown,
): value is ApplicationChannel {
	return (
		typeof value === "string" &&
		(APPLICATION_CHANNEL_SLUGS as readonly string[]).includes(value)
	);
}

/** Look up DimensionTerm metadata for an application channel. */
export function getApplicationChannelTerm(
	channel: ApplicationChannel,
): DimensionTerm<ApplicationChannel> {
	const found = APPLICATION_CHANNELS.find((c) => c.slug === channel);
	if (!found) {
		throw new Error(`Invalid application channel: ${String(channel)}`);
	}
	return found;
}

/** Type guard for `properties.channel_kind` on `job-site` organisations. */
export function isJobSiteChannelKind(
	value: unknown,
): value is JobSiteChannelKind {
	return (
		typeof value === "string" &&
		(JOB_SITE_CHANNEL_KINDS as readonly string[]).includes(value)
	);
}

export const JOB_APPLICATION_DATE_PRECISIONS = [
	"day",
	"month",
	"estimated",
	"unknown",
] as const;

export type JobApplicationDatePrecision =
	(typeof JOB_APPLICATION_DATE_PRECISIONS)[number];

// ---------------------------------------------------------------------------
// 4. Silence & Follow-Up Cadence Constants (#2439 Locked Decisions 1, 4, 5)
// ---------------------------------------------------------------------------

/** Days without an inbound human reply before an `applied` application is `silent`. */
export const SILENT_THRESHOLD_DAYS = 14 as const;

/** Follow-up chase cadence milestones in days (1w, 2w, 4w). */
export const FOLLOWUP_CADENCE_DAYS = [7, 14, 28] as const;

/** Days without an inbound human reply before an `applied` application auto-closes to `closed_no_reply`. */
export const AUTO_CLOSE_DAYS = 42 as const;

/** Default task contract for pre-application (`identified` / `matched`) roles. */
export const PRE_APPLICATION_TASK_TITLE = "Decide: apply or pass" as const;
export const PRE_APPLICATION_TASK_DUE_DAYS = 3 as const;
export const PRE_APPLICATION_TASK_PRIORITY: PriorityLevel = 4;

// ---------------------------------------------------------------------------
// 5. Record & Properties Types
// ---------------------------------------------------------------------------

export interface JobApplicationStageHistoryEntry {
	stage: JobApplicationStage;
	at: string;
	source?: TaskSourceSlug | string;
	evidence_artifact_id?: string | null;
	note?: string | null;
}

export interface JobApplicationProperties {
	kind: typeof JOB_APPLICATION_ENTITY_KIND;
	role_title: string;
	role_category: RoleCategory;
	channel: ApplicationChannel;
	ats?: string | null;
	stage: JobApplicationStage;
	stage_history: JobApplicationStageHistoryEntry[];
	applied_on?: string | null;
	date_precision?: JobApplicationDatePrecision;
	closed_on?: string | null;
	salary_band?: string | null;
	salary_expectation_submitted?: number | null;
	platform_ref?: string | null;
	priority_level?: PriorityLevel | null;
	status: TaskStatusSlug;
	source?: TaskSourceSlug | null;
	notes?: string | null;
	cv_entity_id?: string | null;
}

export interface JobApplicationRecord {
	id?: string;
	org?: string;
	role_title: string;
	role_category: RoleCategory;
	channel: ApplicationChannel;
	stage: JobApplicationStage;
	applied_on?: string | null;
	closed_on?: string | null;
	stage_history?: readonly JobApplicationStageHistoryEntry[];
	last_inbound_at?: string | null;
	priority_level?: PriorityLevel | null;
}

// ---------------------------------------------------------------------------
// 6. Date, Submission, Interview & Silence Helpers
// ---------------------------------------------------------------------------

function parseUtcDayStartMs(dateOrIso: string): number | null {
	const trimmed = dateOrIso.trim();
	if (!trimmed) return null;
	const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
	if (dateMatch) {
		const year = Number(dateMatch[1]);
		const month = Number(dateMatch[2]);
		const day = Number(dateMatch[3]);
		const ms = Date.UTC(year, month - 1, day);
		return Number.isFinite(ms) ? ms : null;
	}
	const parsed = Date.parse(trimmed);
	if (!Number.isFinite(parsed)) return null;
	const d = new Date(parsed);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Compute whole UTC calendar days elapsed from `fromIso` to `toIso`. */
export function daysBetweenUtcDates(fromIso: string, toIso: string): number {
	const fromMs = parseUtcDayStartMs(fromIso);
	const toMs = parseUtcDayStartMs(toIso);
	if (fromMs === null || toMs === null) {
		throw new Error(
			`Invalid date value for daysBetweenUtcDates: from=${String(fromIso)}, to=${String(toIso)}`,
		);
	}
	return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

/** Add `days` UTC calendar days to an ISO date/timestamp and return `YYYY-MM-DD`. */
export function addUtcDays(dateOrIso: string, days: number): string {
	const startMs = parseUtcDayStartMs(dateOrIso);
	if (startMs === null) {
		throw new Error(`Invalid date value for addUtcDays: ${String(dateOrIso)}`);
	}
	const target = new Date(startMs + days * MS_PER_DAY);
	return target.toISOString().slice(0, 10);
}

/** Add `workingDays` Mon-Fri weekdays to an ISO date/timestamp and return `YYYY-MM-DD`. */
export function addUtcWorkingDays(
	dateOrIso: string,
	workingDays: number,
): string {
	const startMs = parseUtcDayStartMs(dateOrIso);
	if (startMs === null) {
		throw new Error(
			`Invalid date value for addUtcWorkingDays: ${String(dateOrIso)}`,
		);
	}
	let cursorMs = startMs;
	let remaining = Math.max(0, Math.floor(workingDays));
	while (remaining > 0) {
		cursorMs += MS_PER_DAY;
		const dow = new Date(cursorMs).getUTCDay();
		if (dow !== 0 && dow !== 6) {
			remaining -= 1;
		}
	}
	return new Date(cursorMs).toISOString().slice(0, 10);
}

/** Normalize a role title for idempotent application matching. */
export function normaliseRoleTitle(roleTitle: string): string {
	return roleTitle
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Format canonical arrangement node title (`"<Organisation> · <Role>"`). */
export function formatJobApplicationTitle(
	organisation: string,
	roleTitle: string,
): string {
	return `${organisation.trim()} · ${roleTitle.trim()}`;
}

/**
 * True when an application counts as submitted (ADR-120 §3):
 * `withdrawn` counts iff `applied_on` is set; pre-application and `drafting`
 * stages are false; `applied` and later stages are true.
 */
export function isSubmitted(
	app: Pick<JobApplicationRecord, "stage" | "applied_on">,
): boolean {
	const def = getJobApplicationStageDefinition(app.stage);
	if (def.submitted === "conditional") {
		return Boolean(app.applied_on && app.applied_on.trim().length > 0);
	}
	return def.submitted;
}

/**
 * True when an application reached `screening` or later at any point (current
 * stage or `stage_history`), even if subsequently `rejected` or `withdrawn`.
 */
export function reachedInterview(
	app: Pick<JobApplicationRecord, "stage" | "stage_history">,
): boolean {
	if (INTERVIEW_REACHED_STAGES.has(app.stage)) {
		return true;
	}
	if (!app.stage_history) return false;
	return app.stage_history.some((entry) =>
		INTERVIEW_REACHED_STAGES.has(entry.stage),
	);
}

function latestStageHistoryAt(
	history: readonly JobApplicationStageHistoryEntry[] | undefined,
	stage: JobApplicationStage,
): string | null {
	if (!history || history.length === 0) return null;
	let latest: string | null = null;
	for (const entry of history) {
		if (entry.stage === stage) {
			latest = entry.at;
		}
	}
	return latest;
}

function resolveSilenceBaseline(
	app: Pick<
		JobApplicationRecord,
		"last_inbound_at" | "applied_on" | "stage_history"
	>,
): string | null {
	const inbound =
		app.last_inbound_at && app.last_inbound_at.trim()
			? app.last_inbound_at.trim()
			: null;
	const submittedAt =
		app.applied_on && app.applied_on.trim()
			? app.applied_on.trim()
			: latestStageHistoryAt(app.stage_history, "applied");
	if (inbound && submittedAt) {
		const inboundDay = parseUtcDayStartMs(inbound);
		const submittedDay = parseUtcDayStartMs(submittedAt);
		if (inboundDay !== null && submittedDay !== null) {
			return inboundDay >= submittedDay ? inbound : submittedAt;
		}
	}
	return inbound ?? submittedAt;
}

/**
 * True when an application is currently in `applied` and at least
 * `SILENT_THRESHOLD_DAYS` (14) calendar days have elapsed without an inbound
 * human reply (#2439 Locked Decision 4).
 */
export function isSilent(
	app: Pick<
		JobApplicationRecord,
		"stage" | "applied_on" | "last_inbound_at" | "stage_history"
	>,
	asOf: string,
): boolean {
	if (app.stage !== "applied") return false;
	const baseline = resolveSilenceBaseline(app);
	if (!baseline) return false;
	return daysBetweenUtcDates(baseline, asOf) >= SILENT_THRESHOLD_DAYS;
}

// ---------------------------------------------------------------------------
// 7. Pre-Application & Stage Next-Action Task Specs
// ---------------------------------------------------------------------------

export interface JobApplicationNextActionSpec {
	title: string;
	due_days: number;
	working_days: boolean;
	priority_level: PriorityLevel;
	energy_mode: TaskEnergyModeSlug;
	status: TaskStatusSlug;
	source: TaskSourceSlug;
}

export interface PreApplicationTaskSpec {
	title: typeof PRE_APPLICATION_TASK_TITLE;
	due_date: string;
	priority_level: PriorityLevel;
	energy_mode: TaskEnergyModeSlug;
	status: TaskStatusSlug;
	source: TaskSourceSlug;
}

/**
 * Build the default `"Decide: apply or pass"` task specification (+3 days,
 * priority 4) for pre-application stages `identified` and `matched`
 * (#2439 Locked Decision 1).
 */
export function buildPreApplicationTaskSpec(
	stage: "identified" | "matched",
	asOf: string,
): PreApplicationTaskSpec {
	return {
		title: PRE_APPLICATION_TASK_TITLE,
		due_date: addUtcDays(asOf, PRE_APPLICATION_TASK_DUE_DAYS),
		priority_level: PRE_APPLICATION_TASK_PRIORITY,
		energy_mode: "quick_win",
		status: "todo",
		source: stage === "identified" ? "owner" : "agent_proposed",
	};
}

/**
 * Return the default open next-action task specification when entering `stage`,
 * or `null` for terminal stages.
 */
export function defaultNextActionForStage(
	stage: JobApplicationStage,
	options?: { screeningCallHeld?: boolean },
): JobApplicationNextActionSpec | null {
	switch (stage) {
		case "identified":
		case "matched":
			return {
				title: PRE_APPLICATION_TASK_TITLE,
				due_days: PRE_APPLICATION_TASK_DUE_DAYS,
				working_days: false,
				priority_level: PRE_APPLICATION_TASK_PRIORITY,
				energy_mode: "quick_win",
				status: "todo",
				source: stage === "identified" ? "owner" : "agent_proposed",
			};
		case "drafting":
			return {
				title: "Finish or drop",
				due_days: 3,
				working_days: false,
				priority_level: 3,
				energy_mode: "deep_work",
				status: "todo",
				source: "owner",
			};
		case "applied":
			return {
				title: "Chase if no reply",
				due_days: FOLLOWUP_CADENCE_DAYS[0],
				working_days: false,
				priority_level: 3,
				energy_mode: "waiting_on",
				status: "todo",
				source: "owner",
			};
		case "screening":
			if (options?.screeningCallHeld) {
				return {
					title: "Follow up for the outcome",
					due_days: 5,
					working_days: true,
					priority_level: 5,
					energy_mode: "waiting_on",
					status: "todo",
					source: "owner",
				};
			}
			return {
				title: "Book the call",
				due_days: 1,
				working_days: true,
				priority_level: 6,
				energy_mode: "admin",
				status: "todo",
				source: "owner",
			};
		case "interviewing":
			return {
				title: "Prepare for the next round",
				due_days: 3,
				working_days: false,
				priority_level: 6,
				energy_mode: "deep_work",
				status: "todo",
				source: "owner",
			};
		case "offer":
			return {
				title: "Decide on the offer",
				due_days: 3,
				working_days: false,
				priority_level: 7,
				energy_mode: "deep_work",
				status: "todo",
				source: "owner",
			};
		case "accepted":
		case "rejected":
		case "withdrawn":
		case "closed_no_reply":
			return null;
	}
}

// ---------------------------------------------------------------------------
// 8. Follow-Up & Auto-Close Cadence Evaluator (#2439 Locked Decision 5)
// ---------------------------------------------------------------------------

export type JobApplicationCadenceMilestoneDays = 7 | 14 | 28 | 42;
export type JobApplicationCadenceAction =
	| "none"
	| "chase_1w"
	| "chase_2w"
	| "chase_4w"
	| "auto_close";

export interface JobApplicationCadenceEvaluation {
	daysElapsed: number | null;
	silent: boolean;
	action: JobApplicationCadenceAction;
	milestoneDays: JobApplicationCadenceMilestoneDays | null;
	chaseNumber: 1 | 2 | 3 | null;
	shouldAutoClose: boolean;
	nextStage: JobApplicationStage | null;
	nextStatus: TaskStatusSlug | null;
	taskSpec: JobApplicationNextActionSpec | null;
}

/**
 * Evaluate the 7 / 14 / 28-day follow-up chase cadence and 42-day auto-close
 * (`closed_no_reply` / `cancelled`) for an application as of `asOf`.
 */
export function evaluateApplicationCadence(
	app: Pick<
		JobApplicationRecord,
		"stage" | "applied_on" | "last_inbound_at" | "stage_history"
	>,
	asOf: string,
): JobApplicationCadenceEvaluation {
	if (app.stage !== "applied") {
		return {
			daysElapsed: null,
			silent: false,
			action: "none",
			milestoneDays: null,
			chaseNumber: null,
			shouldAutoClose: false,
			nextStage: null,
			nextStatus: null,
			taskSpec: null,
		};
	}

	const baseline = resolveSilenceBaseline(app);
	if (!baseline) {
		return {
			daysElapsed: null,
			silent: false,
			action: "none",
			milestoneDays: null,
			chaseNumber: null,
			shouldAutoClose: false,
			nextStage: null,
			nextStatus: null,
			taskSpec: null,
		};
	}

	const daysElapsed = daysBetweenUtcDates(baseline, asOf);
	const silent = daysElapsed >= SILENT_THRESHOLD_DAYS;

	if (daysElapsed >= AUTO_CLOSE_DAYS) {
		return {
			daysElapsed,
			silent: true,
			action: "auto_close",
			milestoneDays: AUTO_CLOSE_DAYS,
			chaseNumber: null,
			shouldAutoClose: true,
			nextStage: "closed_no_reply",
			nextStatus: statusForStage("closed_no_reply"),
			taskSpec: null,
		};
	}

	if (daysElapsed >= FOLLOWUP_CADENCE_DAYS[2]) {
		return {
			daysElapsed,
			silent: true,
			action: "chase_4w",
			milestoneDays: FOLLOWUP_CADENCE_DAYS[2],
			chaseNumber: 3,
			shouldAutoClose: false,
			nextStage: null,
			nextStatus: null,
			taskSpec: {
				title: "Final follow-up (4w chase — auto-closes at 6w)",
				due_days: 0,
				working_days: false,
				priority_level: 4,
				energy_mode: "waiting_on",
				status: "proposed",
				source: "agent_proposed",
			},
		};
	}

	if (daysElapsed >= FOLLOWUP_CADENCE_DAYS[1]) {
		return {
			daysElapsed,
			silent: true,
			action: "chase_2w",
			milestoneDays: FOLLOWUP_CADENCE_DAYS[1],
			chaseNumber: 2,
			shouldAutoClose: false,
			nextStage: null,
			nextStatus: null,
			taskSpec: {
				title: "Follow up (2w chase — no reply)",
				due_days: 0,
				working_days: false,
				priority_level: 4,
				energy_mode: "waiting_on",
				status: "proposed",
				source: "agent_proposed",
			},
		};
	}

	if (daysElapsed >= FOLLOWUP_CADENCE_DAYS[0]) {
		return {
			daysElapsed,
			silent,
			action: "chase_1w",
			milestoneDays: FOLLOWUP_CADENCE_DAYS[0],
			chaseNumber: 1,
			shouldAutoClose: false,
			nextStage: null,
			nextStatus: null,
			taskSpec: {
				title: "Follow up (1w chase)",
				due_days: 0,
				working_days: false,
				priority_level: 3,
				energy_mode: "waiting_on",
				status: "proposed",
				source: "agent_proposed",
			},
		};
	}

	return {
		daysElapsed,
		silent: false,
		action: "none",
		milestoneDays: null,
		chaseNumber: null,
		shouldAutoClose: false,
		nextStage: null,
		nextStatus: null,
		taskSpec: null,
	};
}

// ---------------------------------------------------------------------------
// 9. Derived Pipeline Metrics Aggregator (ADR-052, ADR-120 §6)
// ---------------------------------------------------------------------------

export interface JobApplicationPipelineBreakdown {
	total: number;
	submitted: number;
	reached_interview: number;
	rejected: number;
	silent: number;
	to_review: number;
	drafting: number;
	interview_rate: number;
}

export interface JobApplicationPipelineMetrics
	extends JobApplicationPipelineBreakdown {
	by_channel: Partial<
		Record<ApplicationChannel, JobApplicationPipelineBreakdown>
	>;
	by_category: Partial<Record<RoleCategory, JobApplicationPipelineBreakdown>>;
}

function emptyBreakdown(): JobApplicationPipelineBreakdown {
	return {
		total: 0,
		submitted: 0,
		reached_interview: 0,
		rejected: 0,
		silent: 0,
		to_review: 0,
		drafting: 0,
		interview_rate: 0,
	};
}

function accumulateBreakdown(
	target: JobApplicationPipelineBreakdown,
	flags: {
		submitted: boolean;
		reachedInterview: boolean;
		rejected: boolean;
		silent: boolean;
		toReview: boolean;
		drafting: boolean;
	},
): void {
	target.total += 1;
	if (flags.submitted) target.submitted += 1;
	if (flags.reachedInterview) target.reached_interview += 1;
	if (flags.rejected) target.rejected += 1;
	if (flags.silent) target.silent += 1;
	if (flags.toReview) target.to_review += 1;
	if (flags.drafting) target.drafting += 1;
	target.interview_rate =
		target.submitted > 0 ? target.reached_interview / target.submitted : 0;
}

/**
 * Derive pipeline funnel counts and channel/category breakdowns at read time
 * from a list of job application records as of `asOf` (ADR-052).
 */
export function derivePipelineMetrics(
	applications: readonly JobApplicationRecord[],
	asOf: string,
): JobApplicationPipelineMetrics {
	const overall = emptyBreakdown();
	const byChannel: Partial<
		Record<ApplicationChannel, JobApplicationPipelineBreakdown>
	> = {};
	const byCategory: Partial<
		Record<RoleCategory, JobApplicationPipelineBreakdown>
	> = {};

	for (const app of applications) {
		const flags = {
			submitted: isSubmitted(app),
			reachedInterview: reachedInterview(app),
			rejected: app.stage === "rejected",
			silent: isSilent(app, asOf),
			toReview: isToReviewStage(app.stage),
			drafting: app.stage === "drafting",
		};

		accumulateBreakdown(overall, flags);

		const channelBucket =
			byChannel[app.channel] ?? (byChannel[app.channel] = emptyBreakdown());
		accumulateBreakdown(channelBucket, flags);

		const categoryBucket =
			byCategory[app.role_category] ??
			(byCategory[app.role_category] = emptyBreakdown());
		accumulateBreakdown(categoryBucket, flags);
	}

	return {
		...overall,
		by_channel: byChannel,
		by_category: byCategory,
	};
}

/**
 * Derive the latest ISO timestamp across linked emails, sent mail, stage
 * history entries, and completed tasks (ADR-120 §6).
 */
export function deriveLastActionAt(input: {
	linkedEmailDates?: readonly string[];
	sentMailDates?: readonly string[];
	stageHistory?: readonly JobApplicationStageHistoryEntry[];
	completedTaskDates?: readonly string[];
}): string | null {
	const candidates: string[] = [
		...(input.linkedEmailDates ?? []),
		...(input.sentMailDates ?? []),
		...(input.stageHistory ?? []).map((h) => h.at),
		...(input.completedTaskDates ?? []),
	];
	let latestValue: string | null = null;
	let latestMs = Number.NEGATIVE_INFINITY;
	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		const ms = Date.parse(trimmed);
		if (Number.isFinite(ms) && ms >= latestMs) {
			latestMs = ms;
			latestValue = trimmed;
		}
	}
	return latestValue;
}

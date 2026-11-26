import { z } from "zod";
import {
	APPLICATION_CHANNEL_SLUGS,
	JOB_APPLICATION_DATE_PRECISIONS,
	JOB_APPLICATION_STAGE_SLUGS,
	ROLE_CATEGORY_SLUGS,
	type ApplicationChannel,
	type JobApplicationCadenceEvaluation,
	type JobApplicationDatePrecision,
	type JobApplicationPipelineBreakdown,
	type JobApplicationPipelineMetrics,
	type JobApplicationStage,
	type JobApplicationStageHistoryEntry,
	type RoleCategory,
} from "../../domain/jobApplications.js";
import type { PriorityLevel } from "../../domain/priorityScale.js";
import { TASK_SOURCE_SLUGS, type TaskStatusSlug } from "../../domain/taskDimensions.js";
import { actionConfidenceSchema } from "../types.js";

/**
 * Browser-safe Zod schemas and contract types for `job_application_upsert` and
 * `job_pipeline_read` (ADR-100, ADR-101, ADR-120, #2439).
 */

export const jobApplicationUpsertInput = {
	id: z
		.string()
		.uuid()
		.optional()
		.describe("Existing job application arrangement entity id (for explicit updates)."),
	organisation: z
		.string()
		.min(1)
		.optional()
		.describe("Target organisation name (required when creating if organisation_id is omitted)."),
	organisation_id: z
		.string()
		.uuid()
		.optional()
		.describe("Existing target organisation entity id for the applied_to edge."),
	role_title: z
		.string()
		.min(1)
		.optional()
		.describe("Advertised role title (required when creating a new application)."),
	role_category: z
		.enum(ROLE_CATEGORY_SLUGS)
		.optional()
		.describe(
			"Role category slug (product, ai_engineering, data_leadership, ops_chief_of_staff, solutions, other). Defaults to 'other' on create.",
		),
	channel: z
		.enum(APPLICATION_CHANNEL_SLUGS)
		.optional()
		.describe(
			"Application channel slug (jumpstart, cord, dex_jobs, jack_and_jill, company_site, recruiter, referral, direct_outreach). Defaults to 'company_site' on create.",
		),
	ats: z
		.string()
		.nullable()
		.optional()
		.describe("Optional ATS identifier for company_site applications (e.g. lever, greenhouse, ashby, teamtailor)."),
	stage: z
		.enum(JOB_APPLICATION_STAGE_SLUGS)
		.optional()
		.describe(
			"Canonical ADR-120 stage (identified, matched, drafting, applied, screening, interviewing, offer, accepted, rejected, withdrawn, closed_no_reply). Defaults to 'identified' on create.",
		),
	applied_on: z
		.string()
		.nullable()
		.optional()
		.describe("ISO date (YYYY-MM-DD or ISO 8601) when submitted; null for pre-application or drafting."),
	date_precision: z
		.enum(JOB_APPLICATION_DATE_PRECISIONS)
		.optional()
		.describe("Date precision indicator (day, month, estimated, unknown)."),
	closed_on: z
		.string()
		.nullable()
		.optional()
		.describe("ISO date when entering a terminal stage (auto-filled from as_of if omitted on terminal entry)."),
	last_inbound_at: z
		.string()
		.nullable()
		.optional()
		.describe("ISO timestamp/date of the most recent inbound human reply (resets the 14-day silence clock)."),
	platform_ref: z
		.string()
		.nullable()
		.optional()
		.describe("External reference code (e.g. UCL B28-00397); highest-priority deduplication key."),
	salary_band: z.string().nullable().optional().describe("Advertised salary band string."),
	salary_expectation_submitted: z
		.number()
		.nullable()
		.optional()
		.describe("Numeric salary expectation submitted on the application form (private personal finance data)."),
	priority_level: z
		.number()
		.int()
		.min(1)
		.max(7)
		.nullable()
		.optional()
		.describe("ADR-116 7-point priority level (1 = Trivial to 7 = Critical)."),
	source: z
		.enum(TASK_SOURCE_SLUGS)
		.nullable()
		.optional()
		.describe("ADR-117 source slug (owner, agent_proposed, email_triage, etc.)."),
	notes: z.string().nullable().optional().describe("Short factual notes on the application."),
	tags: z.array(z.string()).optional().describe("Optional tags (always retains 'job-application')."),
	job_site: z
		.string()
		.min(1)
		.optional()
		.describe("Job site or agency name for the applied_via edge (e.g. 'Jumpstart', 'Dex jobs')."),
	job_site_id: z
		.string()
		.uuid()
		.optional()
		.describe("Existing job site or agency organisation entity id for the applied_via edge."),
	recruiter_ids: z
		.array(z.string().uuid())
		.optional()
		.describe("Optional people entity IDs to link via 'recruiter' edges."),
	hiring_contact_ids: z
		.array(z.string().uuid())
		.optional()
		.describe("Optional people entity IDs to link via 'hiring_contact' edges."),
	cv_entity_id: z
		.string()
		.uuid()
		.nullable()
		.optional()
		.describe("Optional tracked CV resource entity id (ADR-098) to link via a 'references' edge (null clears)."),
	area_id: z
		.string()
		.uuid()
		.optional()
		.describe("Optional Job Search area entity id for 'belongs_to' containment (defaults to resolving 'Job Search')."),
	applicant_entity_id: z
		.string()
		.uuid()
		.optional()
		.describe("Optional owner self people entity id for the 'applicant' edge (defaults to person_self if present)."),
	evidence_artifact_id: z
		.string()
		.uuid()
		.optional()
		.describe("Optional provenance artifact id to link via artifact_entity_links and record in stage_history."),
	evidence_link_type: z
		.string()
		.min(1)
		.optional()
		.describe("artifact_entity_links link_type for evidence_artifact_id (default 'related')."),
	stage_note: z
		.string()
		.nullable()
		.optional()
		.describe("Optional note recorded on the stage_history transition entry."),
	screening_call_held: z
		.boolean()
		.optional()
		.describe("When entering 'screening', indicates whether the first call has already occurred (controls default next action)."),
	next_action_title: z
		.string()
		.min(1)
		.optional()
		.describe("Optional explicit title override for the open next-action task."),
	next_action_due_date: z
		.string()
		.optional()
		.describe("Optional explicit due date override (YYYY-MM-DD or ISO 8601) for the open next-action task."),
	skip_task_sync: z
		.boolean()
		.optional()
		.describe("Set true to skip syncing the open user_tasks row (default false)."),
	as_of: z
		.string()
		.optional()
		.describe("Optional ISO date or timestamp used for stage_history and task due-date computation."),
	reapplication: z
		.boolean()
		.optional()
		.describe("Set true to create a separate re-application node when (organisation, role_title) already exists."),
	disambiguation_candidates: z
		.array(
			z.object({
				id: z.string().min(1),
				title: z.string(),
				stage: z.enum(JOB_APPLICATION_STAGE_SLUGS).optional(),
				match_reason: z.string().optional(),
			}),
		)
		.optional()
		.describe(
			"Read-only candidate list attached when unattended ingestion parks an ambiguous match for owner review. Executing without an explicit id (or reapplication: true) refuses rather than creating a duplicate.",
		),
	confidence: actionConfidenceSchema,
} as const;

export const jobApplicationUpsertSchema = z.object(jobApplicationUpsertInput);
export type JobApplicationUpsertInput = z.infer<typeof jobApplicationUpsertSchema>;

export interface JobApplicationCandidate {
	id: string;
	title: string;
	organisation: string | null;
	role_title: string | null;
	stage: JobApplicationStage | null;
	channel: ApplicationChannel | null;
	platform_ref: string | null;
	applied_on: string | null;
	match_reason: string;
}

export interface JobApplicationUpsertResult {
	status: "created" | "updated" | "ambiguous";
	application?: {
		id: string;
		title: string;
		stage: JobApplicationStage;
		entity_status: TaskStatusSlug;
		role_title: string;
		role_category: RoleCategory;
		channel: ApplicationChannel;
		ats: string | null;
		organisation_id: string | null;
		organisation: string | null;
		job_site_id: string | null;
		job_site: string | null;
		cv_entity_id: string | null;
		applied_on: string | null;
		closed_on: string | null;
		last_inbound_at: string | null;
		platform_ref: string | null;
		priority_level: PriorityLevel | null;
		stage_history: JobApplicationStageHistoryEntry[];
	};
	edges?: Array<{
		relationship_type: string;
		to_entity_id: string;
	}>;
	open_task?: {
		id: string;
		title: string;
		status: string;
		due_date: string | null;
		priority_level: number | null;
	} | null;
	candidates?: JobApplicationCandidate[];
	message: string;
}

export const JOB_PIPELINE_STAGE_GROUPS = [
	"all",
	"to_review",
	"drafting",
	"active",
	"submitted",
	"silent",
	"terminal",
] as const;
export type JobPipelineStageGroup = (typeof JOB_PIPELINE_STAGE_GROUPS)[number];

export const jobPipelineReadInput = {
	stage: z
		.enum(JOB_APPLICATION_STAGE_SLUGS)
		.optional()
		.describe("Filter returned applications to one exact stage."),
	stage_group: z
		.enum(JOB_PIPELINE_STAGE_GROUPS)
		.optional()
		.describe(
			"Filter returned applications by pipeline bucket: all, to_review (identified|matched), drafting, active (non-terminal), submitted, silent (>=14d applied without inbound reply), terminal.",
		),
	category: z
		.enum(ROLE_CATEGORY_SLUGS)
		.optional()
		.describe("Filter returned applications by role_category."),
	channel: z
		.enum(APPLICATION_CHANNEL_SLUGS)
		.optional()
		.describe("Filter returned applications by channel."),
	search: z
		.string()
		.optional()
		.describe("Case-insensitive substring search over title, organisation, role_title, platform_ref, or notes."),
	include_closed: z
		.boolean()
		.optional()
		.describe("Include terminal stages (accepted, rejected, withdrawn, closed_no_reply) in returned applications (default true)."),
	include_archived: z
		.boolean()
		.optional()
		.describe("Include archived application entities (default false)."),
	as_of: z
		.string()
		.optional()
		.describe("Reference ISO date or timestamp for silence/cadence/metrics evaluation (defaults to today UTC)."),
} as const;

export const jobPipelineReadSchema = z.object(jobPipelineReadInput);
export type JobPipelineReadInput = z.infer<typeof jobPipelineReadSchema>;

export interface JobPipelineEntityRef {
	id: string;
	title: string;
}

export interface JobPipelineArtifactRef {
	artifact_id: string;
	title: string | null;
	link_type: string | null;
	source_channel: string | null;
	source_url: string | null;
	storage_url: string | null;
	originated_at: string | null;
	captured_at: string | null;
	created_at: string | null;
}

export interface JobPipelineTaskRef {
	id: string;
	title: string;
	status: string;
	priority_level: number | null;
	energy_mode: string | null;
	source: string | null;
	due_date: string | null;
	completed_at: string | null;
}

export interface JobPipelineApplicationItem {
	id: string;
	title: string;
	organisation: JobPipelineEntityRef | null;
	organisation_name: string | null;
	job_site: JobPipelineEntityRef | null;
	applicant_id: string | null;
	recruiters: JobPipelineEntityRef[];
	hiring_contacts: JobPipelineEntityRef[];
	cv: JobPipelineEntityRef | null;
	role_title: string;
	role_category: RoleCategory;
	channel: ApplicationChannel;
	ats: string | null;
	stage: JobApplicationStage;
	entity_status: TaskStatusSlug;
	applied_on: string | null;
	date_precision: JobApplicationDatePrecision | null;
	closed_on: string | null;
	last_inbound_at: string | null;
	last_action_at: string | null;
	platform_ref: string | null;
	salary_band: string | null;
	salary_expectation_submitted: number | null;
	priority_level: PriorityLevel | null;
	source: string | null;
	notes: string | null;
	stage_history: JobApplicationStageHistoryEntry[];
	submitted: boolean;
	reached_interview: boolean;
	silent: boolean;
	cadence: JobApplicationCadenceEvaluation;
	open_task: JobPipelineTaskRef | null;
	tasks: JobPipelineTaskRef[];
	artifacts: JobPipelineArtifactRef[];
}

export interface JobPipelineOrganisationSummary {
	id: string | null;
	title: string;
	application_count: number;
	submitted_count: number;
	stages: Partial<Record<JobApplicationStage, number>>;
}

export interface JobPipelineChannelSummary extends JobApplicationPipelineBreakdown {
	channel: ApplicationChannel;
	job_site: JobPipelineEntityRef | null;
}

export interface JobPipelineRecruiterSummary {
	id: string;
	title: string;
	role: "recruiter" | "hiring_contact";
	application_ids: string[];
	application_count: number;
}

export interface JobPipelineReadResult {
	as_of: string;
	total_count: number;
	filtered_count: number;
	metrics: JobApplicationPipelineMetrics;
	applications: JobPipelineApplicationItem[];
	needs_attention: JobPipelineApplicationItem[];
	organisations: JobPipelineOrganisationSummary[];
	job_sites: JobPipelineChannelSummary[];
	recruiters: JobPipelineRecruiterSummary[];
}

export const JOB_HUNT_GMAIL_MODES = ["shadow", "label", "act"] as const;
export type JobHuntGmailMode = (typeof JOB_HUNT_GMAIL_MODES)[number];

export const jobHuntGmailIngestInput = {
	domain: z
		.enum(["work", "angus"])
		.default("angus")
		.describe(
			"Mailbox domain scope. Must be 'angus' (personal mailbox only; 'work' is rejected per ADR-120 §4).",
		),
	mode: z
		.enum(JOB_HUNT_GMAIL_MODES)
		.default("shadow")
		.describe(
			"Rollout mode: 'shadow' (audit-only watermarks, zero Gmail/approval writes), 'label' (additive ahOS/job-hunt label + Approvals inbox), or 'act' (auto-executes unambiguous updates when auto_apply threshold is enabled and met).",
		),
	dry_run: z
		.boolean()
		.default(false)
		.describe("When true, computes classifications and matches without writing to Supabase or Gmail."),
	query: z
		.string()
		.optional()
		.describe("Optional Gmail search query for inbound/all mail (defaults to 'newer_than:7d')."),
	max_messages: z
		.number()
		.int()
		.min(1)
		.max(500)
		.default(50)
		.describe("Maximum Gmail messages fetched per query (1..500, default 50)."),
	as_of: z
		.string()
		.optional()
		.describe("Optional ISO date or timestamp used for stage_history and task due-date computation."),
} as const;

export const jobHuntGmailIngestSchema = z.object(jobHuntGmailIngestInput);
export type JobHuntGmailIngestInput = z.infer<typeof jobHuntGmailIngestSchema>;

export interface JobHuntGmailIngestItemSummary {
	message_id: string;
	thread_id: string;
	item_key: string;
	kind: "application_update" | "task_only" | "evidence_only";
	rule_id: string;
	outcome:
		| "shadow_logged"
		| "dry_run"
		| "parked_approval"
		| "auto_applied"
		| "task_created"
		| "evidence_linked"
		| "needs_review"
		| "error";
	organisation?: string | null;
	role_title?: string | null;
	stage?: JobApplicationStage | null;
	matched_application_id?: string | null;
	match_step?: "platform_ref" | "thread_id" | "org_role" | "contact_email" | "ambiguous" | "none";
	candidate_ids?: string[];
	hiring_contact?: { name?: string; email?: string } | null;
	decision_id?: string | null;
	task_id?: string | null;
	artifact_id?: string | null;
	error?: string | null;
}

export interface JobHuntGmailIngestResult {
	domain: "angus";
	mode: JobHuntGmailMode;
	dry_run: boolean;
	scanned_messages: number;
	skipped_watermarked: number;
	skipped_seeded_provenance: number;
	ignored_non_job: number;
	classified_updates: number;
	classified_tasks: number;
	classified_evidence: number;
	shadow_logged: number;
	parked_approvals: number;
	auto_applied: number;
	tasks_created: number;
	evidence_linked: number;
	labels_added: number;
	needs_review_count: number;
	errors: string[];
	items: JobHuntGmailIngestItemSummary[];
}

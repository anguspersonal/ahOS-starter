import {
  APPLICATION_CHANNELS,
  APPLICATION_CHANNEL_SLUGS,
  JOB_APPLICATION_STAGES,
  JOB_APPLICATION_STAGE_SLUGS,
  ROLE_CATEGORIES,
  ROLE_CATEGORY_SLUGS,
  getApplicationChannelTerm,
  getJobApplicationStageDefinition,
  getRoleCategoryTerm,
  isToReviewStage,
  jobApplicationUpsertSchema,
  jobPipelineReadSchema,
  type ApplicationChannel,
  type JobApplicationCadenceEvaluation,
  type JobApplicationCandidate,
  type JobApplicationPipelineBreakdown,
  type JobApplicationPipelineMetrics,
  type JobApplicationStage,
  type JobApplicationUpsertInput,
  type JobApplicationUpsertResult,
  type JobPipelineApplicationItem,
  type JobPipelineChannelSummary,
  type JobPipelineOrganisationSummary,
  type JobPipelineReadInput,
  type JobPipelineReadResult,
  type JobPipelineRecruiterSummary,
  type JobPipelineTaskRef,
  type RoleCategory,
} from "@ahkms/core";
import type { z } from "zod";
import { executeActionClient, type ClientActionDefinition } from "./actionClient.js";
import { taskCrudActionClient, type ClientTaskCrudResult } from "./taskActions.js";

export {
  APPLICATION_CHANNELS,
  APPLICATION_CHANNEL_SLUGS,
  JOB_APPLICATION_STAGES,
  JOB_APPLICATION_STAGE_SLUGS,
  ROLE_CATEGORIES,
  ROLE_CATEGORY_SLUGS,
  isToReviewStage,
  jobApplicationUpsertSchema,
  jobPipelineReadSchema,
};
export type {
  ApplicationChannel,
  JobApplicationCadenceEvaluation,
  JobApplicationCandidate,
  JobApplicationPipelineBreakdown,
  JobApplicationPipelineMetrics,
  JobApplicationStage,
  JobApplicationUpsertInput,
  JobApplicationUpsertResult,
  JobPipelineApplicationItem,
  JobPipelineChannelSummary,
  JobPipelineOrganisationSummary,
  JobPipelineReadInput,
  JobPipelineReadResult,
  JobPipelineRecruiterSummary,
  JobPipelineTaskRef,
  RoleCategory,
};

export type JobPipelineReadClientInput = z.input<typeof jobPipelineReadSchema>;
export type JobApplicationUpsertClientInput = z.input<typeof jobApplicationUpsertSchema>;

export interface JobApplicationPendingApprovalResult {
  status: "pending_approval";
  decision_id: string;
  action_id: string;
  message?: string;
}

export type JobApplicationUpsertResponse =
  | JobApplicationUpsertResult
  | JobApplicationPendingApprovalResult;

export function isPendingApprovalResponse(
  res: JobApplicationUpsertResponse,
): res is JobApplicationPendingApprovalResult {
  return res.status === "pending_approval";
}

export const jobPipelineReadActionClient: ClientActionDefinition<
  JobPipelineReadClientInput,
  JobPipelineReadResult
> = {
  id: "job_pipeline_read",
  name: "job_pipeline_read",
  description:
    "Read the ADR-120 job search pipeline, participant edges, linked CV/email artifacts, tasks, 14-day silence flags, 7/14/28/42-day cadence, and funnel metrics.",
  schema: jobPipelineReadSchema as unknown as z.ZodType<JobPipelineReadClientInput>,
};

export const jobApplicationUpsertActionClient: ClientActionDefinition<
  JobApplicationUpsertClientInput,
  JobApplicationUpsertResponse
> = {
  id: "job_application_upsert",
  name: "job_application_upsert",
  description:
    "Create or update a job application arrangement node, participant edges, CV reference edge, provenance links, and open next-action task.",
  schema: jobApplicationUpsertSchema as unknown as z.ZodType<JobApplicationUpsertClientInput>,
};

export async function fetchJobPipeline(
  input: JobPipelineReadClientInput = {},
): Promise<JobPipelineReadResult> {
  return await executeActionClient(jobPipelineReadActionClient, input, "ui");
}

export async function upsertJobApplication(
  input: JobApplicationUpsertClientInput,
): Promise<JobApplicationUpsertResponse> {
  return await executeActionClient(jobApplicationUpsertActionClient, input, "ui");
}

export async function updateApplicationStage(input: {
  id: string;
  stage: JobApplicationStage;
  stage_note?: string | null;
  applied_on?: string | null;
  screening_call_held?: boolean;
}): Promise<JobApplicationUpsertResponse> {
  return await upsertJobApplication({
    id: input.id,
    stage: input.stage,
    ...(input.stage_note !== undefined ? { stage_note: input.stage_note } : {}),
    ...(input.applied_on !== undefined ? { applied_on: input.applied_on } : {}),
    ...(input.screening_call_held !== undefined
      ? { screening_call_held: input.screening_call_held }
      : {}),
  });
}

/**
 * Normalize an HTML `<input type="date">` value (`YYYY-MM-DD`) or ISO timestamp
 * into a UTC `Z` ISO-8601 datetime required by `task_crud`'s `z.string().datetime()`.
 */
export function toTaskDueDateIso(dateInput: string): string {
  const trimmed = dateInput.trim();
  if (!trimmed) {
    throw new Error("Due date cannot be empty.");
  }
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day, 9, 0, 0, 0));
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      throw new Error(`Invalid due date: ${dateInput}`);
    }
    return parsed.toISOString();
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid due date: ${dateInput}`);
  }
  return new Date(ms).toISOString();
}

export async function completeJobHuntTask(
  taskId: string,
): Promise<ClientTaskCrudResult> {
  return await executeActionClient(
    taskCrudActionClient,
    { operation: "complete", id: taskId },
    "ui",
  );
}

export async function rescheduleJobHuntTask(
  taskId: string,
  dateInput: string,
): Promise<ClientTaskCrudResult> {
  const dueDateIso = toTaskDueDateIso(dateInput);
  return await executeActionClient(
    taskCrudActionClient,
    {
      operation: "update",
      id: taskId,
      patch: { due_date: dueDateIso },
    },
    "ui",
  );
}

// ---------------------------------------------------------------------------
// Sub-tabs, filters, status pills, chart builders, and display formatters
// ---------------------------------------------------------------------------

export const JOB_HUNT_SUB_TABS = [
  "applications",
  "organisations",
  "job-sites",
  "recruiters",
] as const;
export type JobHuntSubTab = (typeof JOB_HUNT_SUB_TABS)[number];

export const JOB_HUNT_STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "review", label: "To review" },
  { id: "silent", label: "No reply" },
  { id: "rejected", label: "Rejected" },
  { id: "withdrawn", label: "Withdrawn" },
  { id: "notsub", label: "Not submitted" },
] as const;
export type JobHuntStatusFilter = (typeof JOB_HUNT_STATUS_FILTERS)[number]["id"];

export type JobHuntSortKey = "status" | "applied" | "org";
export type JobHuntSortDirection = 1 | -1;

export type JobHuntPillTone =
  | "interview"
  | "review"
  | "silent"
  | "rejected"
  | "notsub"
  | "active";

export interface JobHuntPillInfo {
  label: string;
  tone: JobHuntPillTone;
  group: Exclude<JobHuntStatusFilter, "all">;
  order: number;
}

export function mapApplicationToPill(
  app: Pick<JobPipelineApplicationItem, "stage" | "silent" | "open_task"> & {
    applied_on?: string | null;
    submitted?: boolean;
  },
): JobHuntPillInfo {
  switch (app.stage) {
    case "screening": {
      const awaitingOutcome = Boolean(
        app.open_task?.title.toLowerCase().includes("outcome"),
      );
      return {
        label: awaitingOutcome ? "Awaiting outcome" : "Screening",
        tone: "interview",
        group: "live",
        order: awaitingOutcome ? 1 : 0,
      };
    }
    case "interviewing":
    case "offer":
    case "accepted":
      return {
        label: getJobApplicationStageDefinition(app.stage).display,
        tone: "interview",
        group: "live",
        order: 0,
      };
    case "identified":
      return {
        label: "Identified",
        tone: "review",
        group: "review",
        order: 2,
      };
    case "matched":
      return {
        label: "To review",
        tone: "review",
        group: "review",
        order: 2,
      };
    case "applied":
      if (app.silent) {
        return {
          label: "No reply",
          tone: "silent",
          group: "silent",
          order: 3,
        };
      }
      return {
        label: "Applied",
        tone: "active",
        group: "live",
        order: 1,
      };
    case "closed_no_reply":
      return {
        label: "Closed, no reply",
        tone: "silent",
        group: "silent",
        order: 4,
      };
    case "rejected":
      return {
        label: "Rejected",
        tone: "rejected",
        group: "rejected",
        order: 5,
      };
    case "drafting":
      return {
        label: "Drafting",
        tone: "notsub",
        group: "notsub",
        order: 6,
      };
    case "withdrawn": {
      const wasSubmitted =
        app.submitted ?? Boolean(app.applied_on && app.applied_on.trim().length > 0);
      return {
        label: "Withdrawn",
        tone: wasSubmitted ? "silent" : "notsub",
        group: wasSubmitted ? "withdrawn" : "notsub",
        order: wasSubmitted ? 5 : 6,
      };
    }
  }
}

export function formatCadenceBadge(
  cadence: Pick<JobApplicationCadenceEvaluation, "action" | "daysElapsed">,
): string | null {
  switch (cadence.action) {
    case "chase_1w":
      return `1w chase (${cadence.daysElapsed ?? 7}d)`;
    case "chase_2w":
      return `2w chase (${cadence.daysElapsed ?? 14}d)`;
    case "chase_4w":
      return `4w final chase (${cadence.daysElapsed ?? 28}d)`;
    case "auto_close":
      return `42d auto-close (${cadence.daysElapsed ?? 42}d)`;
    case "none":
      return null;
  }
}

export function formatRoleCategoryLabel(category: RoleCategory): string {
  return getRoleCategoryTerm(category).display;
}

export function formatChannelLabel(channel: ApplicationChannel): string {
  if (channel === "company_site") return "Company site";
  return getApplicationChannelTerm(channel).display;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatShortDate(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return "—";
  const trimmed = isoOrDate.trim();
  if (!trimmed) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (match) {
    const year = match[1];
    const monthIdx = Number(match[2]) - 1;
    const day = Number(match[3]);
    const month = MONTHS_SHORT[monthIdx];
    if (month && day >= 1 && day <= 31) {
      return `${day} ${month} ${year}`;
    }
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return trimmed;
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function toDateInputValue(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return "";
  const trimmed = isoOrDate.trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (match) return match[1];
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

export interface ApplicationFilterSortOptions {
  statusFilter?: JobHuntStatusFilter;
  categoryFilter?: RoleCategory | "all";
  search?: string;
  sortKey?: JobHuntSortKey;
  sortDir?: JobHuntSortDirection;
}

export function filterAndSortApplications(
  applications: readonly JobPipelineApplicationItem[],
  options: ApplicationFilterSortOptions = {},
): JobPipelineApplicationItem[] {
  const statusFilter = options.statusFilter ?? "all";
  const categoryFilter = options.categoryFilter ?? "all";
  const needle = options.search?.trim().toLowerCase() ?? "";
  const sortKey = options.sortKey ?? "status";
  const sortDir = options.sortDir ?? 1;

  const filtered = applications.filter((app) => {
    if (statusFilter !== "all" && mapApplicationToPill(app).group !== statusFilter) {
      return false;
    }
    if (categoryFilter !== "all" && app.role_category !== categoryFilter) {
      return false;
    }
    if (needle) {
      const hay = [
        app.organisation_name ?? "",
        app.title,
        app.role_title,
        app.platform_ref ?? "",
        app.job_site?.title ?? "",
        app.notes ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "org") {
      const orgA = a.organisation_name ?? a.title;
      const orgB = b.organisation_name ?? b.title;
      cmp = orgA.localeCompare(orgB) || a.role_title.localeCompare(b.role_title);
    } else if (sortKey === "applied") {
      const isoA = a.applied_on ?? a.last_action_at ?? "";
      const isoB = b.applied_on ?? b.last_action_at ?? "";
      cmp = isoA.localeCompare(isoB);
    } else {
      const orderA = mapApplicationToPill(a).order;
      const orderB = mapApplicationToPill(b).order;
      const isoA = a.applied_on ?? a.last_action_at ?? "";
      const isoB = b.applied_on ?? b.last_action_at ?? "";
      cmp = orderA - orderB || isoB.localeCompare(isoA);
    }
    return cmp * sortDir;
  });

  return sorted;
}

export interface StackedChartRow {
  key: string;
  label: string;
  interview: number;
  rejected: number;
  silent: number;
  total: number;
}

export function buildChannelChartRows(
  metrics: JobApplicationPipelineMetrics,
): StackedChartRow[] {
  const rows: StackedChartRow[] = [];
  for (const slug of APPLICATION_CHANNEL_SLUGS) {
    const b = metrics.by_channel[slug];
    if (!b || b.submitted === 0) continue;
    const rejected = Math.max(0, b.rejected);
    const interview = Math.max(0, b.reached_interview);
    const silent = Math.max(0, b.silent);
    const total = Math.max(b.submitted, interview + rejected + silent);
    rows.push({
      key: slug,
      label: slug === "company_site" ? "Company sites" : formatChannelLabel(slug),
      interview,
      rejected,
      silent,
      total,
    });
  }
  return rows.sort((a, b) => b.interview - a.interview || b.total - a.total);
}

export function buildCategoryChartRows(
  metrics: JobApplicationPipelineMetrics,
): StackedChartRow[] {
  const rows: StackedChartRow[] = [];
  for (const slug of ROLE_CATEGORY_SLUGS) {
    const b = metrics.by_category[slug];
    if (!b || b.submitted === 0) continue;
    const rejected = Math.max(0, b.rejected);
    const interview = Math.max(0, b.reached_interview);
    const silent = Math.max(0, b.silent);
    const total = Math.max(b.submitted, interview + rejected + silent);
    rows.push({
      key: slug,
      label: formatRoleCategoryLabel(slug),
      interview,
      rejected,
      silent,
      total,
    });
  }
  return rows.sort((a, b) => b.interview - a.interview || b.total - a.total);
}

export interface JobHuntFindingCard {
  stat: string;
  text: string;
}

export function buildFindingsFromMetrics(
  metrics: JobApplicationPipelineMetrics,
): JobHuntFindingCard[] {
  const jumpstart = metrics.by_channel.jumpstart;
  const companySite = metrics.by_channel.company_site;
  const dexJobs = metrics.by_channel.dex_jobs;
  const coldSubmitted = (companySite?.submitted ?? 0) + (dexJobs?.submitted ?? 0);
  const coldInterviews =
    (companySite?.reached_interview ?? 0) + (dexJobs?.reached_interview ?? 0);

  const aiEng = metrics.by_category.ai_engineering;
  const dataLead = metrics.by_category.data_leadership;
  const product = metrics.by_category.product;

  const jumpInt = jumpstart?.reached_interview ?? 0;
  const totalInt = metrics.reached_interview;
  const engPlusDataTotal = (aiEng?.submitted ?? 0) + (dataLead?.submitted ?? 0);
  const engPlusDataInt =
    (aiEng?.reached_interview ?? 0) + (dataLead?.reached_interview ?? 0);

  return [
    {
      stat: `${jumpInt} of ${totalInt}`,
      text:
        totalInt > 0
          ? `Interviews came via Jumpstart (${jumpInt} of ${totalInt}). Cold company sites and Dex jobs: ${coldSubmitted} submitted, ${coldInterviews} interviews.`
          : `No interviews recorded yet across ${metrics.submitted} submitted applications (${coldSubmitted} via cold company sites and Dex jobs).`,
    },
    {
      stat: `${engPlusDataInt} of ${engPlusDataTotal}`,
      text: `Specialist screening lanes: AI engineering ${aiEng?.reached_interview ?? 0} of ${aiEng?.submitted ?? 0}, data leadership ${dataLead?.reached_interview ?? 0} of ${dataLead?.submitted ?? 0}.`,
    },
    {
      stat: `${product?.reached_interview ?? 0} of ${product?.submitted ?? 0}`,
      text: `Product-builder roles (${product?.reached_interview ?? 0} of ${product?.submitted ?? 0} interviewed) with ${metrics.to_review} pre-application roles waiting for review.`,
    },
  ];
}

export interface NextUpCardItem {
  application: JobPipelineApplicationItem;
  task: JobPipelineTaskRef | null;
  urgent: boolean;
  dueLabel: string;
  actionTitle: string;
}

export function buildNextUpItems(
  data: Pick<JobPipelineReadResult, "applications" | "needs_attention" | "as_of">,
): NextUpCardItem[] {
  const seen = new Set<string>();
  const candidates: JobPipelineApplicationItem[] = [];

  for (const app of data.applications) {
    if (app.open_task && !seen.has(app.id)) {
      seen.add(app.id);
      candidates.push(app);
    }
  }
  for (const app of data.needs_attention) {
    if (!seen.has(app.id)) {
      seen.add(app.id);
      candidates.push(app);
    }
  }

  return candidates
    .map((app) => {
      const task = app.open_task;
      const dueIso = task?.due_date ? toDateInputValue(task.due_date) : "";
      const isOverdueOrUrgent =
        (task?.priority_level ?? 0) >= 5 ||
        app.cadence.shouldAutoClose ||
        Boolean(dueIso && dueIso <= data.as_of);
      const dueLabel = dueIso
        ? formatShortDate(dueIso)
        : app.cadence.action !== "none"
          ? (formatCadenceBadge(app.cadence) ?? "Due soon")
          : "No due date";
      const actionTitle =
        task?.title ??
        app.cadence.taskSpec?.title ??
        (isToReviewStage(app.stage) ? "Decide: apply or pass" : "Follow up");
      return {
        application: app,
        task,
        urgent: isOverdueOrUrgent,
        dueLabel,
        actionTitle,
      };
    })
    .sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      const da = a.task?.due_date ?? "9999-12-31";
      const db = b.task?.due_date ?? "9999-12-31";
      if (da !== db) return da.localeCompare(db);
      return (b.task?.priority_level ?? 0) - (a.task?.priority_level ?? 0);
    });
}

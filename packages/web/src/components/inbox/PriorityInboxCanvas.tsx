import { useState, useEffect, useMemo } from "react";
import { z } from "zod";
import {
  DEFAULT_EMAIL_HITL_POLICY,
  EMAIL_INTENT_CATEGORIES,
  EMAIL_ROUTES,
  EMAIL_ROUTE_LABELS,
  GMAIL_UNSUBSCRIBE_LABEL,
  INBOX_ROUTES,
  MIN_EMAIL_PRIORITY,
  MAX_EMAIL_PRIORITY,
  DEFAULT_PRIORITY_CUT_LINE,
  DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
  DAILY_EMAIL_FLOW_FORMULA,
  DAILY_EMAIL_FLOW_UNREAD_QUERY,
  applyProcessedDeltaToSnapshot,
  buildDailyEmailFlowCapturePayload,
  buildDailyEmailFlowSnapshot,
  captureSchema,
  chainDailyEmailFlowSeries,
  clampEmailPriority,
  classifyEmailTriageTier,
  computeDailyEmailFlowDedupKey,
  gmailUnsubscribeBatchInputSchema,
  parseStoredDailyEmailFlowArtifact,
  formatPriorityBadge,
  getPriorityLevelDefinition,
  type CaptureInput,
  type DailyEmailFlowSnapshot,
  type DailyEmailFlowTrendPoint,
  type DailyInboxFlowMetrics,
  type EmailIntentCategory,
  type EmailRoute,
  type EmailStorageTier,
  type GmailSweepAction,
  type GmailUnsubscribeBatchInput,
  type GmailUnsubscribeBatchOutput,
  type GmailUnsubscribeThreadItem,
  type PriorityLevel,
  type ThinkingMode,
} from "@ahkms/core";
import {
  executeActionClient,
  type ClientActionDefinition,
} from "../../lib/actionClient.js";
import { navigateToTab } from "../../lib/router.js";
import { isSupabaseConfigured, supabase } from "../../lib/supabase.js";
import {
  requestGraphEntitySelection,
  setInboxScreen,
  type InboxDomainFilter,
} from "../../lib/screenState.js";

export type EmailDomain = "work" | "personal";
export type EmailDomainFilter = InboxDomainFilter;

export interface LinkedEntityRef {
  id: string;
  title: string;
  entityType: "person" | "project" | "task" | "concept" | "area" | string;
  hot?: boolean;
}

export interface PriorityInboxThread {
  id: string;
  threadId: string;
  messageId?: string;
  decisionId: string;
  domain: EmailDomain;
  sender: string;
  senderEmail?: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  intentCategory: EmailIntentCategory;
  priority: number;
  confidence?: number;
  storageTier?: EmailStorageTier;
  gmailAction?: GmailSweepAction;
  linkedEntities: LinkedEntityRef[];
  reasons?: string[];
  corrected?: boolean;
  correctionLessonId?: string;
  correctionSummary?: string;
  // ADR-118 decision fields (#2128)
  route?: EmailRoute;
  naturalRoute?: EmailRoute;
  thinkingMode?: ThinkingMode;
  requiresHuman?: boolean;
  hitlReasons?: string[];
  rationale?: string | null;
  overBudget?: boolean;
  draftId?: string | null;
  draftReply?: string | null;
  listUnsubscribe?: string | null;
  sourceUrl?: string | null;
}

export const CURATED_INBOX_ROUTES = [
  "draft_reply",
  "attention",
  "review",
] as const satisfies readonly EmailRoute[];

export const SWEPT_INBOX_ROUTES = [
  "digest",
  "unsubscribe_candidate",
  "calendar",
  "awaiting_reply",
  "archive",
] as const satisfies readonly EmailRoute[];

export type CuratedInboxRoute = (typeof CURATED_INBOX_ROUTES)[number];
export type SweptInboxRoute = (typeof SWEPT_INBOX_ROUTES)[number];

export const EMAIL_ROUTE_TITLES: Readonly<Record<EmailRoute, string>> =
  Object.freeze({
    draft_reply: "Draft Reply",
    attention: "Direct Attention",
    review: "HITL Review Hold",
    digest: "Daily Digest",
    unsubscribe_candidate: "Unsubscribe Candidate",
    calendar: "Calendar Bookkeeping",
    awaiting_reply: "Awaiting Reply",
    archive: "Auto-Archived",
  });

export const REVIEW_LESSON_CATEGORIES = [
  "not_wanted",
  "wrong",
  "not_now",
  "duplicate",
] as const;

export type ReviewLessonCategory = (typeof REVIEW_LESSON_CATEGORIES)[number];

export interface ReviewLessonRecordClientInput {
  decision_id: string;
  category: ReviewLessonCategory;
  summary: string;
  cooldown_days?: number;
  forever?: boolean;
}

export interface ReviewLessonRecordClientOutput {
  id: string;
  subject_key: string;
  cooling_off_until: string | null;
}

export const reviewLessonRecordInputSchema = z.object({
  decision_id: z.string().min(1),
  category: z.enum(REVIEW_LESSON_CATEGORIES),
  summary: z.string().min(1).max(500),
  cooldown_days: z.number().int().min(1).max(365).optional(),
  forever: z.boolean().optional(),
});

export const reviewLessonRecordActionClient: ClientActionDefinition<
  ReviewLessonRecordClientInput,
  ReviewLessonRecordClientOutput
> = {
  id: "review_lesson_record",
  name: "review_lesson_record",
  description:
    "Record a lesson and cooling-off window on a triage decision so future sweeps reflect the owner's priority and intent override.",
  schema: reviewLessonRecordInputSchema,
};

export const gmailUnsubscribeBatchActionClient: ClientActionDefinition<
  GmailUnsubscribeBatchInput,
  GmailUnsubscribeBatchOutput
> = {
  id: "gmail_unsubscribe_batch",
  name: "gmail_unsubscribe_batch",
  description:
    "Label a batch of unsubscribe_candidate Gmail threads with ahOS/Unsubscribe and archive them out of the inbox after a single owner approval.",
  schema:
    gmailUnsubscribeBatchInputSchema as unknown as z.ZodType<GmailUnsubscribeBatchInput>,
};

export interface SubmitUnsubscribeBatchOptions {
  threads: readonly PriorityInboxThread[];
  dryRun?: boolean;
}

export interface SubmitUnsubscribeBatchResult {
  output: GmailUnsubscribeBatchOutput;
  payload: GmailUnsubscribeBatchInput;
  threadIds: string[];
}

/**
 * Dispatches a batch unsubscribe request for `unsubscribe_candidate` threads
 * via `POST /api/actions/gmail_unsubscribe_batch`.
 */
export async function submitUnsubscribeBatch(
  options: SubmitUnsubscribeBatchOptions,
): Promise<SubmitUnsubscribeBatchResult> {
  const candidates = options.threads.filter(
    (thread) =>
      (thread.route ?? "unsubscribe_candidate") === "unsubscribe_candidate" ||
      options.threads.every((t) => t.route !== "unsubscribe_candidate"),
  );
  const items: GmailUnsubscribeThreadItem[] = candidates.map((thread) => ({
    thread_id: thread.threadId,
    account: thread.domain === "work" ? "work" : "personal",
    domain: thread.domain === "work" ? "work" : "personal",
    ...(thread.messageId ? { message_id: thread.messageId } : {}),
    sender: thread.sender,
    subject: thread.subject,
    ...(thread.listUnsubscribe !== undefined
      ? { list_unsubscribe: thread.listUnsubscribe }
      : {}),
    ...(thread.decisionId ? { decision_id: thread.decisionId } : {}),
  }));

  const payload: GmailUnsubscribeBatchInput = {
    threads: items,
    dry_run: options.dryRun ?? false,
  };

  const output = await executeActionClient(
    gmailUnsubscribeBatchActionClient,
    payload,
  );

  return {
    output,
    payload,
    threadIds: candidates.map((thread) => thread.id),
  };
}

/**
 * Builds the Gmail URL to inspect or edit a saved reply draft or thread in place.
 * Sending remains gated in Gmail and is never triggered automatically.
 */
export function buildGmailDraftUrl(thread: PriorityInboxThread): string {
  if (thread.sourceUrl && thread.sourceUrl.trim().length > 0) {
    return thread.sourceUrl.trim();
  }
  const accountIndex = thread.domain === "work" ? "1" : "0";
  if (thread.draftId && thread.draftId.trim().length > 0) {
    return `https://mail.google.com/mail/u/${accountIndex}/#drafts?compose=${encodeURIComponent(
      thread.draftId.trim(),
    )}`;
  }
  return `https://mail.google.com/mail/u/${accountIndex}/#inbox/${encodeURIComponent(
    thread.threadId,
  )}`;
}

export interface CaptureDailyEmailFlowClientOutput {
  id: string;
  title: string;
  deduplicated?: boolean;
  updated?: boolean;
}

export const captureDailyEmailFlowActionClient: ClientActionDefinition<
  CaptureInput,
  CaptureDailyEmailFlowClientOutput
> = {
  id: "capture",
  name: "capture",
  description:
    "Persist or update the Daily Email Flow Scorecard artifact (kpi_email_daily:<YYYY-MM-DD>) via POST /api/actions/capture.",
  schema: captureSchema,
};

/**
 * Persists a `DailyEmailFlowSnapshot` to `public.artifacts` via `POST /api/actions/capture`
 * using `dedup_key = 'kpi_email_daily:<YYYY-MM-DD>'`, `surface = 'kpi_snapshot'`, and
 * `content_subtype = 'daily_email_flow_scorecard'`.
 */
export async function persistDailyEmailFlowSnapshot(
  snapshot: DailyEmailFlowSnapshot,
): Promise<CaptureDailyEmailFlowClientOutput> {
  const payload = buildDailyEmailFlowCapturePayload(snapshot);
  return executeActionClient(captureDailyEmailFlowActionClient, payload);
}

/**
 * Loads persisted Daily Email Flow Scorecards from `public.artifacts`
 * (`content_subtype = 'daily_email_flow_scorecard'`), newest date first,
 * and attaches the multi-day trend history series.
 */
export async function loadStoredDailyEmailFlowSnapshots(
  limit = 14,
  options?: { forceLoad?: boolean },
): Promise<DailyEmailFlowSnapshot[]> {
  if (
    !(options?.forceLoad || isSupabaseConfigured) ||
    !supabase ||
    typeof supabase.from !== "function"
  ) {
    return [];
  }

  const query = supabase.from("artifacts");
  if (!query || typeof query.select !== "function") {
    return [];
  }

  const { data, error } = await query
    .select(
      "id, title, dedup_key, surface, content_subtype, processing_metadata, created_at, updated_at",
    )
    .eq("content_subtype", DAILY_EMAIL_FLOW_CONTENT_SUBTYPE)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !Array.isArray(data)) {
    return [];
  }

  const parsed: DailyEmailFlowSnapshot[] = [];
  const seenDates = new Set<string>();
  for (const row of data) {
    const snapshot = parseStoredDailyEmailFlowArtifact(
      row as Record<string, unknown>,
    );
    if (snapshot && !seenDates.has(snapshot.date_key)) {
      seenDates.add(snapshot.date_key);
      parsed.push(snapshot);
    }
  }

  parsed.sort((a, b) => b.date_key.localeCompare(a.date_key));

  if (parsed.length === 0) {
    return [];
  }

  const chronologicalTrend: DailyEmailFlowTrendPoint[] = [...parsed]
    .sort((a, b) => a.date_key.localeCompare(b.date_key))
    .map((item) => ({
      date_key: item.date_key,
      personal: item.personal,
      work: item.work,
      combined: item.combined,
    }));

  return parsed.map((item, idx) =>
    idx === 0 && (!item.history || item.history.length === 0)
      ? { ...item, history: chronologicalTrend }
      : item,
  );
}

export const INTENT_CATEGORY_LABELS: Readonly<Record<EmailIntentCategory, string>> =
  Object.freeze({
    to_respond: "To Respond",
    fyi: "FYI",
    comment: "Comment",
    notification: "Notification",
    meeting_update: "Meeting Update",
    awaiting_reply: "Awaiting Reply",
    actioned: "Actioned",
    marketing: "Marketing",
  });

export const DOMAIN_FILTER_OPTIONS: ReadonlyArray<{
  value: EmailDomainFilter;
  label: string;
}> = Object.freeze([
  { value: "all", label: "All" },
  { value: "work", label: "Work" },
  { value: "personal", label: "Personal" },
]);

export const PRIORITY_SCALE_VALUES = [1, 2, 3, 4, 5, 6, 7] as const;

export const DEFAULT_PRIORITY_INBOX_THREADS: PriorityInboxThread[] = [
  {
    id: "thread-hl-001",
    threadId: "gmail-th-hl-001",
    messageId: "gmail-msg-hl-001",
    decisionId: "11111111-1111-4111-a111-111111111101",
    domain: "work",
    sender: "Dr. Sarah Chen <sarah@example.com>",
    subject: "Urgent: Clinical pilot sign-off & MSA redlines before Friday",
    snippet:
      "Need final approval on the data processing addendum and clinical pilot timeline before we onboard the first cohort.",
    receivedAt: "2026-10-26T14:30:00Z",
    intentCategory: "to_respond",
    priority: 7,
    confidence: 0.96,
    route: "draft_reply",
    naturalRoute: "draft_reply",
    thinkingMode: "system_2",
    requiresHuman: true,
    hitlReasons: ["route:draft_reply"],
    rationale:
      "Clinical partner requesting final MSA redline and Friday cohort timeline sign-off; System 2 prepared a reply draft.",
    overBudget: false,
    draftId: "draft-hl-001",
    draftReply:
      "Hi Sarah,\n\nThanks for sending over the MSA redlines. I have reviewed the data processing addendum and confirmed the Friday onboarding timeline for the first cohort.\n\nBest,\nAngus",
    linkedEntities: [
      { id: "ent-sarah-chen", title: "Dr. Sarah Chen", entityType: "person", hot: true },
      { id: "ent-clinical-pilot", title: "Work Clinical Pilot", entityType: "project", hot: true },
      { id: "task-pilot-msa", title: "Sign off Clinical Pilot MSA", entityType: "task" },
    ],
    reasons: ["intent:to_respond", "direct_recipient", "urgency_cue", "matched_hot_entities:2", "key_person"],
  },
  {
    id: "thread-hl-002",
    threadId: "gmail-th-hl-002",
    messageId: "gmail-msg-hl-002",
    decisionId: "11111111-1111-4111-a111-111111111102",
    domain: "work",
    sender: "Lead Investor <partner@example.com>",
    subject: "Board prep & Q4 runway review rescheduled",
    snippet:
      "Moving our Q4 metrics and retention walkthrough to Thursday 10:00 GMT. Please share the updated cohort deck.",
    receivedAt: "2026-10-26T13:15:00Z",
    intentCategory: "meeting_update",
    priority: 6,
    confidence: 0.93,
    route: "attention",
    naturalRoute: "attention",
    thinkingMode: "system_2",
    requiresHuman: true,
    hitlReasons: ["route:attention"],
    rationale:
      "Lead investor rescheduled Q4 board review to Thursday 10:00 GMT and asked for the updated cohort retention deck.",
    overBudget: false,
    linkedEntities: [
      { id: "ent-q4-board", title: "Q4 Board Review", entityType: "project", hot: true },
      { id: "ent-seedfund", title: "SeedFund Partners", entityType: "person", hot: true },
    ],
    reasons: ["intent:meeting_update", "direct_recipient", "key_person"],
  },
  {
    id: "thread-ps-001",
    threadId: "gmail-th-ps-001",
    messageId: "gmail-msg-ps-001",
    decisionId: "11111111-1111-4111-a111-111111111103",
    domain: "personal",
    sender: "Solicitor Office <conveyancing@example.com>",
    subject: "Action required: signed completion statement",
    snippet:
      "Please confirm and return the countersigned completion statement before 17:00 today.",
    receivedAt: "2026-10-26T12:45:00Z",
    intentCategory: "to_respond",
    priority: 6,
    confidence: 0.94,
    route: "draft_reply",
    naturalRoute: "draft_reply",
    thinkingMode: "system_2",
    requiresHuman: true,
    hitlReasons: ["route:draft_reply"],
    rationale:
      "Solicitor requires countersigned completion statement returned before 17:00 today.",
    overBudget: false,
    draftId: "draft-ps-001",
    draftReply:
      "Please find attached the countersigned completion statement. Kindly confirm receipt before 17:00 today.",
    linkedEntities: [
      { id: "ent-completion", title: "Property Completion", entityType: "project", hot: true },
    ],
    reasons: ["intent:to_respond", "urgency_cue", "matched_hot_entities:1"],
  },
  {
    id: "thread-hl-003",
    threadId: "gmail-th-hl-003",
    messageId: "gmail-msg-hl-003",
    decisionId: "11111111-1111-4111-a111-111111111104",
    domain: "work",
    sender: "Lina Ops <ops@work.example.com>",
    subject: "Awaiting reply: PostHog & RevenueCat funnel reconciliation",
    snippet:
      "Following up on the attribution mismatch between iOS trial starts and webhook events.",
    receivedAt: "2026-10-26T11:20:00Z",
    intentCategory: "awaiting_reply",
    priority: 5,
    confidence: 0.89,
    route: "attention",
    naturalRoute: "attention",
    thinkingMode: "system_2",
    requiresHuman: true,
    hitlReasons: ["route:attention"],
    rationale:
      "Active webhook attribution audit task awaiting reconciliation sign-off from owner.",
    overBudget: false,
    linkedEntities: [
      { id: "ent-rc-funnel", title: "RevenueCat Funnel Sync", entityType: "project" },
      { id: "task-audit-webhook", title: "Audit trial webhook events", entityType: "task" },
    ],
    reasons: ["intent:awaiting_reply", "active_tasks:1", "pending_reply"],
  },
  {
    id: "thread-ps-002",
    threadId: "gmail-th-ps-002",
    messageId: "gmail-msg-ps-002",
    decisionId: "11111111-1111-4111-a111-111111111105",
    domain: "personal",
    sender: "Alex Rivera <alex@example.com>",
    subject: "Commented on: Knowledge Graph Ontology v2 draft",
    snippet:
      "Left three comments on the T-Box / A-Box hierarchy section and closeness ring decay curve.",
    receivedAt: "2026-10-26T10:05:00Z",
    intentCategory: "comment",
    priority: 5,
    confidence: 0.88,
    route: "review",
    naturalRoute: "digest",
    thinkingMode: "system_2",
    requiresHuman: true,
    hitlReasons: ["mid_confidence_high_stakes", "known_contact_protected"],
    rationale:
      "Known collaborator commented on hot Knowledge Graph project; held by HITL gate because confidence 0.88 is below 0.90 auto-apply band.",
    overBudget: false,
    linkedEntities: [
      { id: "ent-alex-rivera", title: "Alex Rivera", entityType: "person" },
      { id: "ent-ahos-kg", title: "ahOS Knowledge Graph", entityType: "project", hot: true },
    ],
    reasons: ["intent:comment", "direct_recipient", "matched_hot_entities:1"],
  },
  {
    id: "thread-hl-004",
    threadId: "gmail-th-hl-004",
    messageId: "gmail-msg-hl-004",
    decisionId: "11111111-1111-4111-a111-111111111106",
    domain: "work",
    sender: "GitHub Notifications <notifications@example.com>",
    subject: "[anguspersonal/ahOS] PR #2012 merged into dev",
    snippet:
      "Merged 3-tier email triage domain model and 1..7 priority scoring into dev.",
    receivedAt: "2026-10-26T09:50:00Z",
    intentCategory: "fyi",
    priority: 4,
    confidence: 0.86,
    route: "digest",
    naturalRoute: "digest",
    thinkingMode: "system_1",
    requiresHuman: false,
    hitlReasons: [],
    rationale:
      "Automated GitHub merge notification on active repository routed to the daily digest.",
    overBudget: false,
    linkedEntities: [
      { id: "ent-ahos-repo", title: "ahOS Monorepo", entityType: "project" },
    ],
    reasons: ["intent:fyi", "automated_sender", "active_projects:1"],
  },
  {
    id: "thread-ps-003",
    threadId: "gmail-th-ps-003",
    messageId: "gmail-msg-ps-003",
    decisionId: "11111111-1111-4111-a111-111111111107",
    domain: "personal",
    sender: "Cal.com <notifications@example.com>",
    subject: "Booking confirmed: Coffee catch-up next Tuesday",
    snippet: "Your 30-minute catch-up has been added to your Google Calendar.",
    receivedAt: "2026-10-26T08:40:00Z",
    intentCategory: "notification",
    priority: 3,
    confidence: 0.91,
    route: "calendar",
    naturalRoute: "calendar",
    thinkingMode: "system_1",
    requiresHuman: false,
    hitlReasons: [],
    rationale:
      "Automated calendar booking confirmation already reflected on Google Calendar.",
    overBudget: false,
    linkedEntities: [
      { id: "ent-calendar-sync", title: "Calendar Sync", entityType: "concept" },
    ],
    reasons: ["intent:notification", "automated_sender"],
  },
  {
    id: "thread-hl-005",
    threadId: "gmail-th-hl-005",
    messageId: "gmail-msg-hl-005",
    decisionId: "11111111-1111-4111-a111-111111111108",
    domain: "work",
    sender: "Stripe Receipts <receipts@example.com>",
    subject: "Invoice #4821-9012 paid automatically",
    snippet: "Payment of $49.00 for Supabase Pro organization subscription succeeded.",
    receivedAt: "2026-10-26T07:30:00Z",
    intentCategory: "actioned",
    priority: 2,
    confidence: 0.95,
    route: "archive",
    naturalRoute: "archive",
    thinkingMode: "system_1",
    requiresHuman: false,
    hitlReasons: [],
    rationale:
      "Automated Stripe subscription receipt with no owner action required.",
    overBudget: false,
    linkedEntities: [
      { id: "ent-cloud-infra", title: "Cloud Infrastructure", entityType: "area" },
    ],
    reasons: ["intent:actioned", "automated_sender"],
  },
  {
    id: "thread-ps-004",
    threadId: "gmail-th-ps-004",
    messageId: "gmail-msg-ps-004",
    decisionId: "11111111-1111-4111-a111-111111111109",
    domain: "personal",
    sender: "SaaS Weekly Digest <newsletter@example.com>",
    subject: "Top 10 AI growth playbooks this month",
    snippet:
      "Unsubscribe anytime. Sponsored roundup of B2B marketing webinars and templates.",
    receivedAt: "2026-10-26T06:15:00Z",
    intentCategory: "marketing",
    priority: 1,
    confidence: 0.99,
    route: "unsubscribe_candidate",
    naturalRoute: "unsubscribe_candidate",
    thinkingMode: "system_1",
    requiresHuman: false,
    hitlReasons: [],
    rationale:
      "Bulk marketing newsletter with List-Unsubscribe header; candidate for batch unsubscribe.",
    overBudget: false,
    listUnsubscribe: "<mailto:unsubscribe@example.com>, <https://saasweekly.io/unsubscribe>",
    linkedEntities: [],
    reasons: ["intent:marketing", "automated_sender", "noise_signal"],
  },
];

export interface FilterAndPartitionOptions {
  domain?: EmailDomainFilter;
  cutLine?: number;
  intentFilter?: EmailIntentCategory | "all" | null;
  routeFilter?: EmailRoute | "all" | null;
  attentionBudget?: number;
}

export interface FilteredPartitionedInbox {
  domain: EmailDomainFilter;
  cutLine: number;
  intentFilter: EmailIntentCategory | "all";
  routeFilter: EmailRoute | "all";
  curated: PriorityInboxThread[];
  swept: PriorityInboxThread[];
  byRoute: Record<EmailRoute, PriorityInboxThread[]>;
  curatedByRoute: Record<CuratedInboxRoute, PriorityInboxThread[]>;
  sweptByRoute: Record<SweptInboxRoute, PriorityInboxThread[]>;
  countsByRoute: Record<EmailRoute, number>;
  attentionBudget: number;
  needsAttentionCount: number;
  overBudgetCount: number;
  overBudget: boolean;
  shouldSweepLowPriority: boolean;
  countsByDomain: {
    all: number;
    work: number;
    personal: number;
  };
}

function inferDefaultRouteForThread(
  thread: PriorityInboxThread,
  cutLine: number,
): EmailRoute {
  const clampedPriority = clampEmailPriority(thread.priority);
  const hasExplicitCutLineOverride = cutLine !== DEFAULT_PRIORITY_CUT_LINE;

  if (thread.route) {
    if (hasExplicitCutLineOverride) {
      if (
        cutLine < DEFAULT_PRIORITY_CUT_LINE &&
        !INBOX_ROUTES.has(thread.route) &&
        clampedPriority >= cutLine
      ) {
        return thread.draftReply || thread.draftId ? "draft_reply" : "attention";
      }
      if (
        cutLine > DEFAULT_PRIORITY_CUT_LINE &&
        INBOX_ROUTES.has(thread.route) &&
        clampedPriority < cutLine &&
        clampedPriority >= DEFAULT_PRIORITY_CUT_LINE
      ) {
        return "digest";
      }
    }
    return thread.route;
  }

  if (
    thread.requiresHuman === true ||
    (Array.isArray(thread.hitlReasons) &&
      thread.hitlReasons.length > 0 &&
      clampedPriority < cutLine)
  ) {
    return clampedPriority >= cutLine
      ? thread.draftReply || thread.draftId
        ? "draft_reply"
        : "attention"
      : "review";
  }

  if (clampedPriority >= cutLine) {
    return thread.draftReply || thread.draftId ? "draft_reply" : "attention";
  }

  if (thread.intentCategory === "marketing") {
    return "unsubscribe_candidate";
  }
  if (thread.intentCategory === "meeting_update") {
    return "calendar";
  }
  if (thread.intentCategory === "awaiting_reply") {
    return "awaiting_reply";
  }
  if (
    thread.intentCategory === "fyi" ||
    thread.intentCategory === "comment" ||
    thread.intentCategory === "to_respond"
  ) {
    return "digest";
  }
  return "archive";
}

function parseThreadReceivedMs(receivedAt: string): number {
  const ms = Date.parse(receivedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Pure helper that filters triage threads by domain, optional intent category,
 * and optional ADR-118 route, groups them by route (`draft_reply`, `attention`,
 * `review` in the curated inbox; `digest`, `unsubscribe_candidate`, `calendar`,
 * `awaiting_reply`, `archive` in the sweep/route sections), and computes daily
 * attention-budget metrics (`needsAttentionCount`, `overBudgetCount`, `overBudget`).
 */
export function filterAndPartitionInboxThreads(
  threads: readonly PriorityInboxThread[],
  options: FilterAndPartitionOptions = {},
): FilteredPartitionedInbox {
  const domain: EmailDomainFilter = options.domain ?? "all";
  const cutLine = clampEmailPriority(options.cutLine ?? DEFAULT_PRIORITY_CUT_LINE);
  const intentFilter: EmailIntentCategory | "all" =
    options.intentFilter && options.intentFilter !== "all"
      ? options.intentFilter
      : "all";
  const routeFilter: EmailRoute | "all" =
    options.routeFilter && options.routeFilter !== "all"
      ? options.routeFilter
      : "all";
  const attentionBudget = Math.max(
    1,
    Math.round(
      options.attentionBudget ?? DEFAULT_EMAIL_HITL_POLICY.dailyAttentionBudget,
    ),
  );

  const countsByDomain = {
    all: threads.length,
    work: threads.filter((t) => t.domain === "work").length,
    personal: threads.filter((t) => t.domain === "personal").length,
  };

  const domainFiltered = threads.filter((thread) => {
    if (domain !== "all" && thread.domain !== domain) {
      return false;
    }
    if (intentFilter !== "all" && thread.intentCategory !== intentFilter) {
      return false;
    }
    const resolvedRoute = inferDefaultRouteForThread(thread, cutLine);
    if (routeFilter !== "all" && resolvedRoute !== routeFilter) {
      return false;
    }
    return true;
  });

  const rawCurated: Array<{ thread: PriorityInboxThread; route: EmailRoute }> = [];
  const rawSwept: Array<{ thread: PriorityInboxThread; route: EmailRoute }> = [];

  for (const thread of domainFiltered) {
    const route = inferDefaultRouteForThread(thread, cutLine);
    if (INBOX_ROUTES.has(route)) {
      rawCurated.push({ thread, route });
    } else {
      rawSwept.push({ thread, route });
    }
  }

  rawCurated.sort((a, b) => {
    const pDiff =
      clampEmailPriority(b.thread.priority) -
      clampEmailPriority(a.thread.priority);
    if (pDiff !== 0) {
      return pDiff;
    }
    return (
      parseThreadReceivedMs(b.thread.receivedAt) -
      parseThreadReceivedMs(a.thread.receivedAt)
    );
  });

  rawSwept.sort((a, b) => {
    const tDiff =
      parseThreadReceivedMs(b.thread.receivedAt) -
      parseThreadReceivedMs(a.thread.receivedAt);
    if (tDiff !== 0) {
      return tDiff;
    }
    return (
      clampEmailPriority(b.thread.priority) -
      clampEmailPriority(a.thread.priority)
    );
  });

  const shouldSweepLowPriority = rawCurated.length > 0;

  const decorateThread = (
    thread: PriorityInboxThread,
    route: EmailRoute,
    curatedIndex?: number,
  ): PriorityInboxThread => {
    const clampedPriority = clampEmailPriority(thread.priority);
    const isInboxRoute = INBOX_ROUTES.has(route);
    const tierClassification = classifyEmailTriageTier(clampedPriority, cutLine, {
      confidence: thread.confidence ?? 1,
      hasHighPriorityItems: shouldSweepLowPriority,
    });
    const naturalRoute = thread.naturalRoute ?? route;
    const thinkingMode: ThinkingMode =
      thread.thinkingMode ?? (isInboxRoute ? "system_2" : "system_1");
    const requiresHuman = thread.requiresHuman ?? isInboxRoute;
    const hitlReasons =
      thread.hitlReasons ?? (isInboxRoute ? [`route:${route}`] : []);
    const computedOverBudget =
      typeof thread.overBudget === "boolean"
        ? thread.overBudget
        : isInboxRoute &&
          curatedIndex !== undefined &&
          curatedIndex >= attentionBudget &&
          clampedPriority < MAX_EMAIL_PRIORITY;

    return {
      ...thread,
      priority: clampedPriority,
      route,
      naturalRoute,
      thinkingMode,
      requiresHuman,
      hitlReasons,
      overBudget: computedOverBudget,
      storageTier: isInboxRoute
        ? "tier_3_full_artifact"
        : tierClassification.storageTier,
      gmailAction: isInboxRoute
        ? "keep_inbox"
        : tierClassification.gmailAction,
    };
  };

  const curated = rawCurated.map((entry, idx) =>
    decorateThread(entry.thread, entry.route, idx),
  );
  const swept = rawSwept.map((entry) =>
    decorateThread(entry.thread, entry.route),
  );

  const byRoute: Record<EmailRoute, PriorityInboxThread[]> = {
    draft_reply: [],
    attention: [],
    review: [],
    calendar: [],
    awaiting_reply: [],
    digest: [],
    archive: [],
    unsubscribe_candidate: [],
  };

  for (const item of curated) {
    const r = item.route ?? "attention";
    byRoute[r].push(item);
  }
  for (const item of swept) {
    const r = item.route ?? "archive";
    byRoute[r].push(item);
  }

  const curatedByRoute: Record<CuratedInboxRoute, PriorityInboxThread[]> = {
    draft_reply: byRoute.draft_reply,
    attention: byRoute.attention,
    review: byRoute.review,
  };

  const sweptByRoute: Record<SweptInboxRoute, PriorityInboxThread[]> = {
    digest: byRoute.digest,
    unsubscribe_candidate: byRoute.unsubscribe_candidate,
    calendar: byRoute.calendar,
    awaiting_reply: byRoute.awaiting_reply,
    archive: byRoute.archive,
  };

  const countsByRoute = Object.fromEntries(
    EMAIL_ROUTES.map((r) => [r, byRoute[r].length]),
  ) as Record<EmailRoute, number>;

  const needsAttentionCount = curated.length;
  const explicitOverBudgetThreads = [...curated, ...swept].filter(
    (t) => t.overBudget === true,
  ).length;
  const overBudgetCount = Math.max(
    explicitOverBudgetThreads,
    Math.max(0, needsAttentionCount - attentionBudget),
  );
  const overBudget =
    overBudgetCount > 0 || needsAttentionCount > attentionBudget;

  return {
    domain,
    cutLine,
    intentFilter,
    routeFilter,
    curated,
    swept,
    byRoute,
    curatedByRoute,
    sweptByRoute,
    countsByRoute,
    attentionBudget,
    needsAttentionCount,
    overBudgetCount,
    overBudget,
    shouldSweepLowPriority,
    countsByDomain,
  };
}

export interface TriageCorrectionOptions {
  thread: PriorityInboxThread;
  cutLine?: number;
  newPriority?: number;
  newIntentCategory?: EmailIntentCategory;
  newRoute?: EmailRoute;
  lessonCategory?: ReviewLessonCategory;
  customSummary?: string;
  cooldownDays?: number;
  forever?: boolean;
}

export interface TriageCorrectionResult {
  updatedThread: PriorityInboxThread;
  lesson: ReviewLessonRecordClientOutput;
  payload: ReviewLessonRecordClientInput;
}

/**
 * Dispatches a one-click triage override to `/api/actions/review_lesson_record`
 * and returns the promoted/updated thread record alongside the recorded lesson.
 */
export async function submitTriageCorrection(
  options: TriageCorrectionOptions,
): Promise<TriageCorrectionResult> {
  const { thread } = options;
  const effectiveCutLine = clampEmailPriority(
    options.cutLine ?? DEFAULT_PRIORITY_CUT_LINE,
  );
  const targetPriority = clampEmailPriority(
    options.newPriority ?? Math.max(effectiveCutLine, DEFAULT_PRIORITY_CUT_LINE),
  );
  const targetIntent: EmailIntentCategory =
    options.newIntentCategory ??
    (thread.intentCategory === "marketing" ||
    thread.intentCategory === "notification" ||
    thread.intentCategory === "actioned"
      ? "to_respond"
      : thread.intentCategory);
  const lessonCategory: ReviewLessonCategory = options.lessonCategory ?? "wrong";

  const summary =
    options.customSummary?.trim() ||
    `Override email triage for "${thread.subject}" (${thread.sender}): priority ${thread.priority} -> ${targetPriority}, intent ${thread.intentCategory} -> ${targetIntent}`;

  const payload: ReviewLessonRecordClientInput = {
    decision_id: thread.decisionId,
    category: lessonCategory,
    summary,
    ...(options.cooldownDays !== undefined
      ? { cooldown_days: options.cooldownDays }
      : {}),
    ...(options.forever !== undefined ? { forever: options.forever } : {}),
  };

  const lesson = await executeActionClient(reviewLessonRecordActionClient, payload);

  const tierClassification = classifyEmailTriageTier(
    targetPriority,
    effectiveCutLine,
    {
      confidence: 1,
      hasHighPriorityItems: true,
    },
  );

  const nextRoute: EmailRoute =
    options.newRoute ??
    (targetPriority >= effectiveCutLine
      ? thread.draftReply || thread.draftId
        ? "draft_reply"
        : "attention"
      : targetIntent === "marketing"
        ? "unsubscribe_candidate"
        : targetIntent === "meeting_update"
          ? "calendar"
          : targetIntent === "awaiting_reply"
            ? "awaiting_reply"
            : "digest");

  const updatedThread: PriorityInboxThread = {
    ...thread,
    priority: targetPriority,
    intentCategory: targetIntent,
    route: nextRoute,
    naturalRoute: nextRoute,
    requiresHuman: INBOX_ROUTES.has(nextRoute),
    hitlReasons: INBOX_ROUTES.has(nextRoute) ? [`route:${nextRoute}`] : [],
    storageTier: tierClassification.storageTier,
    gmailAction: tierClassification.gmailAction,
    corrected: true,
    correctionLessonId: lesson.id,
    correctionSummary: summary,
  };

  return {
    updatedThread,
    lesson,
    payload,
  };
}

function getPriorityBadgeClasses(priority: number): string {
  const p = clampEmailPriority(priority);
  if (p >= 7) {
    return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  }
  if (p === 6) {
    return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  }
  if (p === 5) {
    return "bg-indigo-500/20 text-indigo-300 border-indigo-500/40";
  }
  if (p === 4) {
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  }
  return "bg-slate-800 text-slate-300 border-slate-700";
}

function getIntentBadgeClasses(intent: EmailIntentCategory): string {
  switch (intent) {
    case "to_respond":
      return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    case "meeting_update":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "awaiting_reply":
      return "bg-indigo-500/15 text-indigo-300 border-indigo-500/30";
    case "comment":
      return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
    case "fyi":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "notification":
      return "bg-slate-800 text-slate-300 border-slate-700";
    case "actioned":
      return "bg-teal-500/15 text-teal-300 border-teal-500/30";
    case "marketing":
      return "bg-purple-500/15 text-purple-300 border-purple-500/30";
  }
}

function getRouteBadgeClasses(route: EmailRoute): string {
  switch (route) {
    case "draft_reply":
      return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
    case "attention":
      return "bg-indigo-500/20 text-indigo-300 border-indigo-500/40";
    case "review":
      return "bg-amber-500/20 text-amber-300 border-amber-500/40";
    case "digest":
      return "bg-sky-500/15 text-sky-300 border-sky-500/30";
    case "unsubscribe_candidate":
      return "bg-purple-500/20 text-purple-300 border-purple-500/40";
    case "calendar":
      return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
    case "awaiting_reply":
      return "bg-violet-500/15 text-violet-300 border-violet-500/30";
    case "archive":
      return "bg-slate-800 text-slate-300 border-slate-700";
  }
}

function getThinkingModeBadgeClasses(mode: ThinkingMode): string {
  return mode === "system_2"
    ? "bg-violet-500/15 text-violet-300 border-violet-500/30"
    : "bg-slate-800 text-slate-300 border-slate-700";
}

function getDomainPillClasses(domain: EmailDomain): string {
  return domain === "work"
    ? "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30"
    : "bg-sky-500/15 text-sky-300 border-sky-500/30";
}

export interface PriorityInboxCanvasProps {
  initialThreads?: PriorityInboxThread[];
  initialDomain?: EmailDomainFilter;
  initialCutLine?: number;
  initialIntentFilter?: EmailIntentCategory | "all";
  initialRouteFilter?: EmailRoute | "all";
  attentionBudget?: number;
  initialAttentionBudget?: number;
  initialSweepDrawerOpen?: boolean;
  initialDailyFlow?: DailyEmailFlowSnapshot;
  initialProcessedThreadIds?: Record<string, boolean>;
  autoLoadDailyFlow?: boolean;
  persistDailyFlowChanges?: boolean;
  onCorrectionSubmitted?: (result: TriageCorrectionResult) => void;
  onUnsubscribeBatchSubmitted?: (result: SubmitUnsubscribeBatchResult) => void;
  onDailyFlowChange?: (snapshot: DailyEmailFlowSnapshot) => void;
}

export const DEFAULT_DAILY_EMAIL_FLOW_HISTORY: DailyEmailFlowTrendPoint[] =
  chainDailyEmailFlowSeries([
    {
      date_key: "2026-11-05",
      personal: { starting: 155, new_today: 20, processed_today: 30 },
      work: { starting: 105, new_today: 15, processed_today: 25 },
    },
    {
      date_key: "2026-11-06",
      personal: { new_today: 18, processed_today: 33 },
      work: { new_today: 12, processed_today: 27 },
    },
    {
      date_key: "2026-11-07",
      personal: { starting: 130, new_today: 24, processed_today: 0, end: 154 },
      work: { starting: 80, new_today: 16, processed_today: 0, end: 96 },
    },
  ]);

/**
 * Default daily unread & processed email flow baseline (`End = Starting + New Today - Processed Today`)
 * tracking Personal (`angus`), Work (`work`), and Combined (`all`).
 * Combined starts at: Starting 210 + New Today 40 - Processed 0 = End 250.
 */
export const DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT: DailyEmailFlowSnapshot =
  buildDailyEmailFlowSnapshot({
    date_key: "2026-11-07",
    generated_at: "2026-11-07T09:00:00.000Z",
    personal: {
      starting: 130,
      new_today: 24,
      processed_today: 0,
      end: 154,
    },
    work: {
      starting: 80,
      new_today: 16,
      processed_today: 0,
      end: 96,
    },
    history: DEFAULT_DAILY_EMAIL_FLOW_HISTORY,
  });

/**
 * Returns the daily flow metrics for the currently selected domain filter
 * (`all` -> `combined`, `work` -> `work`, `personal` -> `personal`).
 */
export function selectActiveDomainFlow(
  snapshot: DailyEmailFlowSnapshot,
  domain: EmailDomainFilter,
): DailyInboxFlowMetrics {
  if (domain === "work") {
    return snapshot.work;
  }
  if (domain === "personal") {
    return snapshot.personal;
  }
  return snapshot.combined;
}

/**
 * Reconciles `processedThreadIds` and `dailyFlow` when a thread is promoted to or above `cutLine`
 * via One-Click Override after previously being marked processed (e.g. via "Process Swept Batch").
 */
export function reconcilePromotionWithProcessedState(
  state: {
    processedThreadIds: Record<string, boolean>;
    dailyFlow: DailyEmailFlowSnapshot;
  },
  updatedThread: PriorityInboxThread,
  cutLine: number,
): {
  reversed: boolean;
  processedThreadIds: Record<string, boolean>;
  dailyFlow: DailyEmailFlowSnapshot;
} {
  if (
    updatedThread.priority >= cutLine &&
    state.processedThreadIds[updatedThread.id]
  ) {
    const nextProcessed = { ...state.processedThreadIds };
    delete nextProcessed[updatedThread.id];
    const nextFlow = applyProcessedDeltaToSnapshot(
      state.dailyFlow,
      updatedThread.domain,
      -1,
      { isSwept: true },
    );
    return {
      reversed: true,
      processedThreadIds: nextProcessed,
      dailyFlow: nextFlow,
    };
  }
  return {
    reversed: false,
    processedThreadIds: state.processedThreadIds,
    dailyFlow: state.dailyFlow,
  };
}

export function PriorityInboxCanvas({
  initialThreads = DEFAULT_PRIORITY_INBOX_THREADS,
  initialDomain = "all",
  initialCutLine = DEFAULT_PRIORITY_CUT_LINE,
  initialIntentFilter = "all",
  initialRouteFilter = "all",
  attentionBudget,
  initialAttentionBudget,
  initialSweepDrawerOpen = true,
  initialDailyFlow = DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT,
  initialProcessedThreadIds = {},
  autoLoadDailyFlow = true,
  persistDailyFlowChanges = true,
  onCorrectionSubmitted,
  onUnsubscribeBatchSubmitted,
  onDailyFlowChange,
}: PriorityInboxCanvasProps = {}) {
  const effectiveAttentionBudget =
    attentionBudget ??
    initialAttentionBudget ??
    DEFAULT_EMAIL_HITL_POLICY.dailyAttentionBudget;

  const [threads, setThreads] = useState<PriorityInboxThread[]>(() => [
    ...initialThreads,
  ]);
  const [dailyFlow, setDailyFlow] = useState<DailyEmailFlowSnapshot>(
    () => initialDailyFlow,
  );
  const [dailyFlowPersistStatus, setDailyFlowPersistStatus] = useState<
    string | null
  >(null);
  const [dailyFlowPersistError, setDailyFlowPersistError] = useState<
    string | null
  >(null);
  const [processedThreadIds, setProcessedThreadIds] = useState<
    Record<string, boolean>
  >(() => ({ ...initialProcessedThreadIds }));
  const [domainFilter, setDomainFilter] = useState<EmailDomainFilter>(initialDomain);
  const [cutLine, setCutLine] = useState<number>(() =>
    clampEmailPriority(initialCutLine),
  );
  const [intentFilter, setIntentFilter] = useState<EmailIntentCategory | "all">(
    initialIntentFilter,
  );
  const [routeFilter, setRouteFilter] = useState<EmailRoute | "all">(
    initialRouteFilter,
  );
  const [sweepDrawerOpen, setSweepDrawerOpen] = useState<boolean>(
    initialSweepDrawerOpen,
  );
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [lastCorrection, setLastCorrection] =
    useState<TriageCorrectionResult | null>(null);
  const [unsubscribingBatch, setUnsubscribingBatch] = useState<boolean>(false);
  const [unsubscribeError, setUnsubscribeError] = useState<string | null>(null);
  const [lastUnsubscribeResult, setLastUnsubscribeResult] =
    useState<SubmitUnsubscribeBatchResult | null>(null);
  const [overridePriorityByThread, setOverridePriorityByThread] = useState<
    Record<string, number>
  >({});
  const [overrideIntentByThread, setOverrideIntentByThread] = useState<
    Record<string, EmailIntentCategory>
  >({});

  const activeDomainFlow = useMemo(
    () => selectActiveDomainFlow(dailyFlow, domainFilter),
    [dailyFlow, domainFilter],
  );

  const syncSnapshotToStore = (snapshotToSave: DailyEmailFlowSnapshot) => {
    if (!persistDailyFlowChanges) {
      return;
    }
    setDailyFlowPersistError(null);
    void persistDailyEmailFlowSnapshot(snapshotToSave)
      .then(() => {
        setDailyFlowPersistStatus(
          `Saved ${computeDailyEmailFlowDedupKey(snapshotToSave.date_key)}`,
        );
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to persist daily email flow scorecard";
        setDailyFlowPersistError(msg);
      });
  };

  useEffect(() => {
    if (!autoLoadDailyFlow) {
      return;
    }
    let cancelled = false;
    void loadStoredDailyEmailFlowSnapshots(14)
      .then((stored) => {
        if (!cancelled && stored.length > 0) {
          setDailyFlow(stored[0]);
          setDailyFlowPersistStatus(
            `Loaded ${computeDailyEmailFlowDedupKey(stored[0].date_key)}`,
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDailyFlowPersistError(
            err instanceof Error
              ? err.message
              : "Failed to load daily email flow history",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [autoLoadDailyFlow]);

  const handleMarkThreadProcessed = (
    thread: PriorityInboxThread,
    isSwept = false,
  ) => {
    if (processedThreadIds[thread.id]) {
      return;
    }
    setProcessedThreadIds((prev) => ({ ...prev, [thread.id]: true }));
    const nextSnapshot = applyProcessedDeltaToSnapshot(
      dailyFlow,
      thread.domain,
      1,
      { isSwept },
    );
    setDailyFlow(nextSnapshot);
    onDailyFlowChange?.(nextSnapshot);
    syncSnapshotToStore(nextSnapshot);
  };

  const handleSweepLowPriorityBatch = () => {
    const unswept = partitioned.swept.filter(
      (thread) => !processedThreadIds[thread.id],
    );
    if (unswept.length === 0) {
      return;
    }
    const nextProcessedMap = { ...processedThreadIds };
    let nextSnapshot = dailyFlow;
    for (const thread of unswept) {
      nextProcessedMap[thread.id] = true;
      nextSnapshot = applyProcessedDeltaToSnapshot(
        nextSnapshot,
        thread.domain,
        1,
        { isSwept: true },
      );
    }
    setProcessedThreadIds(nextProcessedMap);
    setDailyFlow(nextSnapshot);
    onDailyFlowChange?.(nextSnapshot);
    syncSnapshotToStore(nextSnapshot);
  };

  const partitioned = useMemo(
    () =>
      filterAndPartitionInboxThreads(threads, {
        domain: domainFilter,
        cutLine,
        intentFilter,
        routeFilter,
        attentionBudget: effectiveAttentionBudget,
      }),
    [
      threads,
      domainFilter,
      cutLine,
      intentFilter,
      routeFilter,
      effectiveAttentionBudget,
    ],
  );

  useEffect(() => {
    setInboxScreen({
      domain: domainFilter,
      cut_line: cutLine,
      intent_filter: intentFilter === "all" ? null : intentFilter,
      route_filter: routeFilter === "all" ? null : routeFilter,
      curated_count: partitioned.curated.length,
      swept_count: partitioned.swept.length,
      drawer_open: sweepDrawerOpen,
      attention_budget: partitioned.attentionBudget,
      needs_attention_count: partitioned.needsAttentionCount,
      over_budget_count: partitioned.overBudgetCount,
      over_budget: partitioned.overBudget,
      counts_by_route: partitioned.countsByRoute,
    });
    return () => {
      setInboxScreen(null);
    };
  }, [
    domainFilter,
    cutLine,
    intentFilter,
    routeFilter,
    partitioned.curated.length,
    partitioned.swept.length,
    partitioned.attentionBudget,
    partitioned.needsAttentionCount,
    partitioned.overBudgetCount,
    partitioned.overBudget,
    partitioned.countsByRoute,
    sweepDrawerOpen,
  ]);

  const handleEntityClick = (entityId: string) => {
    requestGraphEntitySelection(entityId);
    navigateToTab("graph");
  };

  const handleUnsubscribeBatch = async (
    candidateThreads?: readonly PriorityInboxThread[],
  ) => {
    const targets =
      candidateThreads ??
      partitioned.sweptByRoute.unsubscribe_candidate.filter(
        (thread) => !processedThreadIds[thread.id],
      );
    if (targets.length === 0) {
      return;
    }
    setUnsubscribingBatch(true);
    setUnsubscribeError(null);
    try {
      const result = await submitUnsubscribeBatch({
        threads: targets,
      });
      const nextProcessedMap = { ...processedThreadIds };
      let nextSnapshot = dailyFlow;
      for (const thread of targets) {
        if (!nextProcessedMap[thread.id]) {
          nextProcessedMap[thread.id] = true;
          nextSnapshot = applyProcessedDeltaToSnapshot(
            nextSnapshot,
            thread.domain,
            1,
            { isSwept: true },
          );
        }
      }
      setProcessedThreadIds(nextProcessedMap);
      setDailyFlow(nextSnapshot);
      onDailyFlowChange?.(nextSnapshot);
      syncSnapshotToStore(nextSnapshot);
      setLastUnsubscribeResult(result);
      onUnsubscribeBatchSubmitted?.(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUnsubscribeError(message);
    } finally {
      setUnsubscribingBatch(false);
    }
  };

  const handleOneClickCorrection = async (
    thread: PriorityInboxThread,
    explicitPriority?: number,
    explicitIntent?: EmailIntentCategory,
  ) => {
    setCorrectingId(thread.id);
    setCorrectionError(null);
    try {
      const targetPriority =
        explicitPriority ??
        overridePriorityByThread[thread.id] ??
        Math.max(cutLine, DEFAULT_PRIORITY_CUT_LINE);
      const targetIntent =
        explicitIntent ?? overrideIntentByThread[thread.id];

      const result = await submitTriageCorrection({
        thread,
        cutLine,
        newPriority: targetPriority,
        newIntentCategory: targetIntent,
      });

      setThreads((prev) =>
        prev.map((item) =>
          item.id === thread.id ? result.updatedThread : item,
        ),
      );
      if (
        result.updatedThread.priority >= cutLine &&
        processedThreadIds[thread.id]
      ) {
        setProcessedThreadIds((prev) => {
          const next = { ...prev };
          delete next[thread.id];
          return next;
        });
        const nextSnapshot = applyProcessedDeltaToSnapshot(
          dailyFlow,
          thread.domain,
          -1,
          { isSwept: true },
        );
        setDailyFlow((prev) =>
          applyProcessedDeltaToSnapshot(prev, thread.domain, -1, {
            isSwept: true,
          }),
        );
        onDailyFlowChange?.(nextSnapshot);
        syncSnapshotToStore(nextSnapshot);
      }
      setLastCorrection(result);
      onCorrectionSubmitted?.(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      setCorrectionError(message);
    } finally {
      setCorrectingId(null);
    }
  };

  return (
    <div className="space-y-6" data-testid="priority-inbox-canvas">
      {/* 1. Header & ADR-118 Attention Budget Banner */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-xl font-bold text-white tracking-tight">
              Curated Priority Inbox
            </h2>
            <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 text-xs font-mono font-semibold rounded-full">
              {cutLine}+ Cut-Line
            </span>
            <span className="px-2 py-0.5 bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[11px] font-mono rounded-full">
              3-Tier Storage
            </span>
            <span
              data-testid="attention-budget-headline"
              className={`px-2.5 py-0.5 text-xs font-mono font-semibold rounded-full border ${
                partitioned.overBudget
                  ? "bg-rose-500/20 text-rose-200 border-rose-500/40"
                  : "bg-sky-500/15 text-sky-300 border-sky-500/30"
              }`}
            >
              Attention Budget: {partitioned.needsAttentionCount} of{" "}
              {partitioned.attentionBudget} today
            </span>
            {partitioned.overBudget && (
              <span
                data-testid="attention-budget-overflow-badge"
                className="px-2.5 py-0.5 bg-amber-500/20 border border-amber-500/40 text-amber-200 text-xs font-mono font-bold rounded-full"
              >
                Over Attention Budget ({partitioned.overBudgetCount} overflow)
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Knowledge-graph-enriched 1..7 email priority triage, ADR-118 route grouping, and System 1 / System 2 stakes-weighted HITL across Work and Personal (#1990 / #2014 / #2128).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="curated-count-badge"
            className="px-2.5 py-1 bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-semibold rounded-lg font-mono"
          >
            {partitioned.curated.length} High-Priority ({cutLine}+)
          </span>
          <span
            data-testid="swept-count-badge"
            className="px-2.5 py-1 bg-slate-900 border border-slate-800 text-slate-300 text-xs font-medium rounded-lg font-mono"
          >
            {partitioned.swept.length} Swept (1..{Math.max(1, cutLine - 1)})
          </span>
          <span
            data-testid="attention-budget-status-badge"
            className={`px-2.5 py-1 text-xs font-mono rounded-lg border ${
              partitioned.overBudget
                ? "bg-rose-500/15 border-rose-500/40 text-rose-300"
                : "bg-sky-500/10 border-sky-500/30 text-sky-300"
            }`}
          >
            {partitioned.needsAttentionCount} of {partitioned.attentionBudget} today
          </span>
          <span
            data-testid="sweep-rule-badge"
            className={`px-2.5 py-1 text-xs font-mono rounded-lg border ${
              partitioned.shouldSweepLowPriority
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                : "bg-amber-500/10 border-amber-500/30 text-amber-300"
            }`}
          >
            {partitioned.shouldSweepLowPriority
              ? "Dynamic Sweep: Active"
              : "Dynamic Sweep: Hold (0 High-Priority)"}
          </span>
        </div>
      </div>

      {/* 1b. Daily Email Flow Waterfall Scorecard (Starting + New Today - Processed = End) */}
      <section
        aria-label="Daily email flow scorecard"
        data-testid="daily-email-flow-section"
        className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl space-y-4"
      >
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-bold text-white tracking-tight">
                Daily Unread &amp; Processed Email Flow ({dailyFlow.date_key})
              </h3>
              <span
                data-testid="daily-flow-formula-badge"
                className="px-2 py-0.5 bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-[11px] font-mono rounded"
              >
                {DAILY_EMAIL_FLOW_FORMULA}
              </span>
              <span className="px-2 py-0.5 bg-slate-950 border border-slate-800 text-slate-400 text-[11px] font-mono rounded">
                Scope: {DAILY_EMAIL_FLOW_UNREAD_QUERY}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Tracks <strong className="text-slate-200">Starting</strong>,{" "}
              <strong className="text-slate-200">New Today</strong>,{" "}
              <strong className="text-emerald-300">Processed ↑</strong>, and{" "}
              <strong className="text-indigo-300">End ↓</strong> across Personal
              (angus), Work (work), and Combined (all).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {dailyFlowPersistStatus && !dailyFlowPersistError && (
              <span
                data-testid="daily-flow-persist-status"
                className="px-2 py-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11px] font-mono rounded-lg"
              >
                {dailyFlowPersistStatus}
              </span>
            )}
            {dailyFlowPersistError && (
              <span
                data-testid="daily-flow-persist-error"
                className="px-2 py-1 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] font-mono rounded-lg"
              >
                {dailyFlowPersistError}
              </span>
            )}
            <span
              data-testid="daily-flow-active-scope-badge"
              className="px-2.5 py-1 bg-slate-950 border border-slate-800 text-slate-300 text-xs font-mono rounded-lg"
            >
              Active View:{" "}
              {domainFilter === "all"
                ? "Combined (All)"
                : domainFilter === "work"
                  ? "Work (work)"
                  : "Personal (angus)"}
            </span>
            <button
              type="button"
              data-testid="save-daily-flow-btn"
              onClick={() => syncSnapshotToStore(dailyFlow)}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg transition-colors"
            >
              Save Scorecard
            </button>
            <button
              type="button"
              data-testid="process-swept-batch-btn"
              onClick={handleSweepLowPriorityBatch}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm"
            >
              Process Swept Batch ({partitioned.swept.filter((t) => !processedThreadIds[t.id]).length})
            </button>
          </div>
        </div>

        {/* 4 Waterfall Cards for Active Domain */}
        <div
          data-testid="daily-flow-waterfall-cards"
          className="grid grid-cols-2 lg:grid-cols-4 gap-3"
        >
          <div
            data-testid="flow-card-starting"
            className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1"
          >
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
              <span>1. Starting Unread</span>
              <span>00:00 UTC</span>
            </div>
            <div
              data-testid="flow-active-starting"
              className="text-2xl font-bold font-mono text-white"
            >
              {activeDomainFlow.starting}
            </div>
            <div className="text-[11px] font-mono text-slate-500">
              Personal {dailyFlow.personal.starting} · Work {dailyFlow.work.starting}
            </div>
          </div>

          <div
            data-testid="flow-card-new-today"
            className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1"
          >
            <div className="flex items-center justify-between text-[11px] font-mono text-amber-300">
              <span>2. + New Today</span>
              <span>Inflow</span>
            </div>
            <div
              data-testid="flow-active-new-today"
              className="text-2xl font-bold font-mono text-amber-300"
            >
              +{activeDomainFlow.new_today}
            </div>
            <div className="text-[11px] font-mono text-slate-500">
              Personal +{dailyFlow.personal.new_today} · Work +{dailyFlow.work.new_today}
            </div>
          </div>

          <div
            data-testid="flow-card-processed-today"
            className="p-3.5 bg-emerald-950/20 border border-emerald-500/30 rounded-xl space-y-1"
          >
            <div className="flex items-center justify-between text-[11px] font-mono text-emerald-300">
              <span>3. − Processed Today ↑</span>
              <span>{activeDomainFlow.clearance_rate_pct}% clearance</span>
            </div>
            <div
              data-testid="flow-active-processed-today"
              className="text-2xl font-bold font-mono text-emerald-400"
            >
              {activeDomainFlow.processed_today}
            </div>
            <div className="text-[11px] font-mono text-emerald-300/80">
              Personal {dailyFlow.personal.processed_today} · Work {dailyFlow.work.processed_today}
            </div>
          </div>

          <div
            data-testid="flow-card-end"
            className="p-3.5 bg-indigo-950/25 border border-indigo-500/30 rounded-xl space-y-1"
          >
            <div className="flex items-center justify-between text-[11px] font-mono text-indigo-300">
              <span>4. = End Unread ↓</span>
              <span
                data-testid="flow-active-net-delta"
                className={
                  activeDomainFlow.net_delta <= 0
                    ? "text-emerald-400"
                    : "text-amber-300"
                }
              >
                {activeDomainFlow.net_delta > 0
                  ? `+${activeDomainFlow.net_delta} vs Start`
                  : `${activeDomainFlow.net_delta} vs Start`}
              </span>
            </div>
            <div
              data-testid="flow-active-end"
              className="text-2xl font-bold font-mono text-white"
            >
              {activeDomainFlow.end}
            </div>
            <div className="text-[11px] font-mono text-indigo-200/80">
              Personal {dailyFlow.personal.end} · Work {dailyFlow.work.end}
            </div>
          </div>
        </div>

        {/* Per-Inbox & Combined Side-by-Side Breakdown Table */}
        <div className="overflow-x-auto">
          <table
            data-testid="daily-email-flow-breakdown-table"
            className="w-full text-left border-collapse text-xs font-mono"
          >
            <thead>
              <tr className="border-b border-slate-800 text-[11px] text-slate-400">
                <th className="py-2 pr-4">Inbox Scope</th>
                <th className="py-2 px-3 text-right">Starting</th>
                <th className="py-2 px-3 text-right">+ New Today</th>
                <th className="py-2 px-3 text-right">− Processed ↑</th>
                <th className="py-2 px-3 text-right">= End Unread ↓</th>
                <th className="py-2 px-3 text-right">Net Delta</th>
                <th className="py-2 pl-3 text-right">Clearance Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {[
                {
                  key: "personal",
                  label: "Personal (angus)",
                  metrics: dailyFlow.personal,
                  active: domainFilter === "personal",
                },
                {
                  key: "work",
                  label: "Work (work)",
                  metrics: dailyFlow.work,
                  active: domainFilter === "work",
                },
                {
                  key: "all",
                  label: "Combined (All Inboxes)",
                  metrics: dailyFlow.combined,
                  active: domainFilter === "all",
                },
              ].map((row) => (
                <tr
                  key={row.key}
                  data-testid={`flow-row-${row.key}`}
                  className={
                    row.active
                      ? "bg-indigo-950/25 text-white font-semibold"
                      : "text-slate-300"
                  }
                >
                  <td className="py-2 pr-4">
                    <span>{row.label}</span>
                  </td>
                  <td
                    data-testid={`flow-${row.key}-starting`}
                    className="py-2 px-3 text-right"
                  >
                    {row.metrics.starting}
                  </td>
                  <td
                    data-testid={`flow-${row.key}-new-today`}
                    className="py-2 px-3 text-right text-amber-300"
                  >
                    +{row.metrics.new_today}
                  </td>
                  <td
                    data-testid={`flow-${row.key}-processed-today`}
                    className="py-2 px-3 text-right text-emerald-400"
                  >
                    {row.metrics.processed_today}
                  </td>
                  <td
                    data-testid={`flow-${row.key}-end`}
                    className="py-2 px-3 text-right text-indigo-200 font-bold"
                  >
                    {row.metrics.end}
                  </td>
                  <td
                    data-testid={`flow-${row.key}-net-delta`}
                    className={`py-2 px-3 text-right ${
                      row.metrics.net_delta <= 0
                        ? "text-emerald-400"
                        : "text-amber-300"
                    }`}
                  >
                    {row.metrics.net_delta > 0
                      ? `+${row.metrics.net_delta}`
                      : row.metrics.net_delta}
                  </td>
                  <td
                    data-testid={`flow-${row.key}-clearance`}
                    className="py-2 pl-3 text-right text-slate-300"
                  >
                    {row.metrics.clearance_rate_pct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 2. Domain Filter Toggle & Priority Cut-Line Controls */}
      <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          {/* Domain Toggle: All | Work | Personal */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">
              Domain Filter
            </span>
            <div
              role="group"
              aria-label="Domain filter"
              className="inline-flex items-center p-1 bg-slate-950 border border-slate-800 rounded-lg gap-1"
            >
              {DOMAIN_FILTER_OPTIONS.map((option) => {
                const isSelected = domainFilter === option.value;
                const count = partitioned.countsByDomain[option.value];
                return (
                  <button
                    key={option.value}
                    type="button"
                    data-testid={`domain-filter-${option.value}`}
                    aria-pressed={isSelected}
                    onClick={() => setDomainFilter(option.value)}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                      isSelected
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                    }`}
                  >
                    <span>{option.label}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${
                        isSelected
                          ? "bg-indigo-500/40 text-indigo-100"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Configurable Priority Cut-Line Selector (1..7, default 5+) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="priority-cut-line-select"
                className="text-[11px] font-semibold uppercase tracking-wider text-slate-400"
              >
                Priority Cut-Line (1..7 Scale)
              </label>
              <span className="text-[11px] font-mono text-indigo-400">
                Tier 3 promotion at {cutLine}+
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div
                role="group"
                aria-label="Priority cut-line buttons"
                className="inline-flex items-center p-1 bg-slate-950 border border-slate-800 rounded-lg gap-1"
              >
                {PRIORITY_SCALE_VALUES.map((score) => {
                  const active = cutLine === score;
                  return (
                    <button
                      key={score}
                      type="button"
                      data-testid={`cut-line-btn-${score}`}
                      aria-pressed={active}
                      onClick={() => setCutLine(clampEmailPriority(score))}
                      className={`px-2.5 py-1 rounded text-xs font-mono font-semibold transition-colors ${
                        active
                          ? "bg-indigo-600 text-white"
                          : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                      }`}
                    >
                      {score}+
                    </button>
                  );
                })}
              </div>

              <select
                id="priority-cut-line-select"
                aria-label="Priority cut-line"
                data-testid="priority-cut-line-select"
                value={cutLine}
                onChange={(e) => setCutLine(clampEmailPriority(Number(e.target.value)))}
                className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
              >
                {PRIORITY_SCALE_VALUES.map((score) => (
                  <option key={score} value={score}>
                    Cut-line {score}+ {getPriorityLevelDefinition(score as PriorityLevel).title} (1..{MAX_EMAIL_PRIORITY})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* 8-Category Orthogonal Intent Filter Pills */}
        <div className="pt-3 border-t border-slate-800/80 space-y-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">
            Intent Category Filter (8 Semantic Categories)
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="intent-filter-all"
              aria-pressed={intentFilter === "all"}
              onClick={() => setIntentFilter("all")}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                intentFilter === "all"
                  ? "bg-indigo-600/30 border-indigo-500 text-indigo-200"
                  : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
            >
              All Intents
            </button>
            {EMAIL_INTENT_CATEGORIES.map((category) => {
              const active = intentFilter === category;
              return (
                <button
                  key={category}
                  type="button"
                  data-testid={`intent-filter-${category}`}
                  aria-pressed={active}
                  onClick={() => setIntentFilter(category)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                    active
                      ? "bg-indigo-600/30 border-indigo-500 text-indigo-200"
                      : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <span>{INTENT_CATEGORY_LABELS[category]}</span>
                  <span className="font-mono text-[10px] opacity-75">
                    ({category})
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ADR-118 Route Filter Pills (8 Deterministic Routes) */}
        <div className="pt-3 border-t border-slate-800/80 space-y-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">
            ADR-118 Route Filter (Inbox vs Sweep Routes)
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="route-filter-all"
              aria-pressed={routeFilter === "all"}
              onClick={() => setRouteFilter("all")}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                routeFilter === "all"
                  ? "bg-indigo-600/30 border-indigo-500 text-indigo-200"
                  : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
            >
              All Routes
            </button>
            {EMAIL_ROUTES.map((route) => {
              const active = routeFilter === route;
              const count = partitioned.countsByRoute[route];
              return (
                <button
                  key={route}
                  type="button"
                  data-testid={`route-filter-${route}`}
                  aria-pressed={active}
                  onClick={() => setRouteFilter(route)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                    active
                      ? "bg-indigo-600/30 border-indigo-500 text-indigo-200"
                      : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <span>{EMAIL_ROUTE_TITLES[route]}</span>
                  <span className="font-mono text-[10px] opacity-75">
                    ({route}: {count})
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Feedback Banner for Recorded Correction Lessons */}
      {lastCorrection && (
        <div
          data-testid="correction-success-banner"
          className="p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-between text-xs text-emerald-300"
        >
          <div>
            <span className="font-semibold">Triage override recorded: </span>
            <span>{lastCorrection.payload.summary}</span>
            <span className="ml-2 font-mono text-[11px] text-emerald-400">
              (lesson: {lastCorrection.lesson.id})
            </span>
          </div>
        </div>
      )}

      {correctionError && (
        <div
          data-testid="correction-error-banner"
          className="p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-300"
        >
          Failed to record triage lesson: {correctionError}
        </div>
      )}

      {lastUnsubscribeResult && (
        <div
          data-testid="unsubscribe-batch-success-banner"
          className="p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-between text-xs text-emerald-300"
        >
          <div>
            <span className="font-semibold">Unsubscribe batch applied: </span>
            <span>
              Labeled {lastUnsubscribeResult.output.labeled_count} of{" "}
              {lastUnsubscribeResult.output.requested_count} thread(s) with{" "}
              {lastUnsubscribeResult.output.label} and archived out of Inbox.
            </span>
          </div>
        </div>
      )}

      {unsubscribeError && (
        <div
          data-testid="unsubscribe-batch-error-banner"
          className="p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-300"
        >
          Failed to apply unsubscribe batch: {unsubscribeError}
        </div>
      )}

      {/* 3. Uncapped High-Priority Curated Thread List (Grouped by ADR-118 Curated Routes) */}
      <section
        aria-label="Curated high-priority threads"
        data-testid="curated-threads-section"
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              High-Priority Curated Threads ({cutLine}+ Uncapped)
            </h3>
            <span className="text-xs font-mono text-slate-400">
              Showing all {partitioned.curated.length} thread(s) across{" "}
              {CURATED_INBOX_ROUTES.join(", ")}
            </span>
          </div>
          <span className="text-[11px] font-mono text-indigo-400">
            Tier 3: Full Artifact + Entity Links + Task Extraction
          </span>
        </div>

        {partitioned.curated.length === 0 ? (
          <div
            data-testid="curated-empty-state"
            className="p-8 bg-slate-900/50 border border-slate-800 rounded-xl text-center space-y-1"
          >
            <p className="text-sm font-medium text-slate-300">
              No threads meet the {cutLine}+ priority cut-line or curated route filter.
            </p>
            <p className="text-xs text-slate-400">
              Lower the priority cut-line or inspect the Sweep Audit Drawer below.
            </p>
          </div>
        ) : (
          <div className="space-y-5" data-testid="curated-thread-list">
            {CURATED_INBOX_ROUTES.map((routeKey) => {
              const groupThreads = partitioned.curatedByRoute[routeKey];
              if (groupThreads.length === 0) {
                return null;
              }
              return (
                <div
                  key={routeKey}
                  data-testid={`route-group-${routeKey}`}
                  className="space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-2">
                      <span
                        data-testid={`route-group-header-${routeKey}`}
                        className="text-xs font-bold uppercase tracking-wider text-slate-200"
                      >
                        {EMAIL_ROUTE_TITLES[routeKey]} ({routeKey})
                      </span>
                      <span className="px-2 py-0.5 bg-slate-800 border border-slate-700 text-[11px] font-mono text-slate-300 rounded-full">
                        {groupThreads.length} thread(s)
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        Gmail Label: {EMAIL_ROUTE_LABELS[routeKey]}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {groupThreads.map((thread) => {
                      const effectiveRoute = inferDefaultRouteForThread(
                        thread,
                        cutLine,
                      );
                      const effectiveThinkingMode =
                        thread.thinkingMode ??
                        (effectiveRoute === "draft_reply" ||
                        effectiveRoute === "attention" ||
                        effectiveRoute === "review"
                          ? "system_2"
                          : "system_1");
                      const hitlReasons = thread.hitlReasons ?? [];
                      const showDraftPanel =
                        effectiveRoute === "draft_reply" ||
                        Boolean(
                          thread.draftReply && thread.draftReply.trim().length > 0,
                        );

                      return (
                        <article
                          key={thread.id}
                          data-testid={`curated-thread-${thread.id}`}
                          data-priority={thread.priority}
                          data-domain={thread.domain}
                          data-intent={thread.intentCategory}
                          data-route={effectiveRoute}
                          data-thinking-mode={effectiveThinkingMode}
                          className="p-4 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl space-y-3 transition-colors"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                              {/* 1..7 Priority Score Badge */}
                              <span
                                data-testid={`priority-badge-${thread.id}`}
                                className={`px-2.5 py-0.5 text-xs font-mono font-bold rounded-md border ${getPriorityBadgeClasses(
                                  thread.priority,
                                )}`}
                              >
                                {formatPriorityBadge(
                                  clampEmailPriority(
                                    thread.priority,
                                  ) as PriorityLevel,
                                )}
                              </span>

                              {/* ADR-118 Route Badge */}
                              <span
                                data-testid={`route-badge-${thread.id}`}
                                className={`px-2.5 py-0.5 text-xs font-mono font-semibold rounded-md border ${getRouteBadgeClasses(
                                  effectiveRoute,
                                )}`}
                              >
                                {EMAIL_ROUTE_TITLES[effectiveRoute]} [
                                {effectiveRoute}] ({EMAIL_ROUTE_LABELS[effectiveRoute]})
                                {thread.naturalRoute &&
                                  thread.naturalRoute !== effectiveRoute && (
                                    <span className="ml-1 opacity-80">
                                      ← {thread.naturalRoute}
                                    </span>
                                  )}
                              </span>

                              {/* Thinking Mode Badge (System 1 vs System 2) */}
                              <span
                                data-testid={`thinking-mode-badge-${thread.id}`}
                                className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded-md border ${getThinkingModeBadgeClasses(
                                  effectiveThinkingMode,
                                )}`}
                              >
                                {effectiveThinkingMode === "system_2"
                                  ? "System 2 (Deep HITL)"
                                  : "System 1 (Fast Triage)"}{" "}
                                [{effectiveThinkingMode}]
                              </span>

                              {/* 8-Category Orthogonal Intent Badge */}
                              <span
                                data-testid={`intent-badge-${thread.id}`}
                                className={`px-2.5 py-0.5 text-xs font-medium rounded-md border ${getIntentBadgeClasses(
                                  thread.intentCategory,
                                )}`}
                              >
                                {INTENT_CATEGORY_LABELS[thread.intentCategory]}{" "}
                                <span className="font-mono text-[10px] opacity-80">
                                  [{thread.intentCategory}]
                                </span>
                              </span>

                              {/* Domain Pill (Work | Personal) */}
                              <span
                                data-testid={`domain-pill-${thread.id}`}
                                className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded-full border ${getDomainPillClasses(
                                  thread.domain,
                                )}`}
                              >
                                {thread.domain === "work"
                                  ? "Work"
                                  : "Personal"}{" "}
                                ({thread.domain})
                              </span>

                              {/* Storage Tier Badge */}
                              <span className="px-2 py-0.5 bg-slate-950 border border-slate-800 text-[10px] font-mono text-slate-400 rounded">
                                {thread.storageTier ?? "tier_3_full_artifact"}
                              </span>

                              {thread.overBudget && (
                                <span
                                  data-testid={`over-budget-badge-${thread.id}`}
                                  className="px-2 py-0.5 bg-amber-500/20 border border-amber-500/40 text-[10px] font-mono font-semibold text-amber-200 rounded"
                                >
                                  Over Attention Budget
                                </span>
                              )}

                              {thread.corrected && (
                                <span className="px-2 py-0.5 bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-mono text-emerald-300 rounded">
                                  Overridden
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-mono text-slate-400">
                                {thread.receivedAt}
                              </span>
                              <button
                                type="button"
                                disabled={Boolean(processedThreadIds[thread.id])}
                                data-testid={`process-thread-${thread.id}`}
                                onClick={() =>
                                  handleMarkThreadProcessed(thread, false)
                                }
                                className={`px-2.5 py-1 rounded text-[11px] font-mono font-semibold border transition-colors ${
                                  processedThreadIds[thread.id]
                                    ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300 cursor-default"
                                    : "bg-slate-950 border-slate-700 text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300"
                                }`}
                              >
                                {processedThreadIds[thread.id]
                                  ? "Processed ✓"
                                  : "Mark Processed"}
                              </button>
                            </div>
                          </div>

                          {/* Sender, Subject & Snippet */}
                          <div className="space-y-1">
                            <div className="text-xs font-mono text-slate-300">
                              From:{" "}
                              <span className="text-slate-100 font-medium">
                                {thread.sender}
                              </span>
                            </div>
                            <h4 className="text-sm font-semibold text-white">
                              {thread.subject}
                            </h4>
                            <p className="text-xs text-slate-300 leading-relaxed">
                              {thread.snippet}
                            </p>
                          </div>

                          {/* System 2 Rationale & HITL Escalation Reasons */}
                          {(thread.rationale || hitlReasons.length > 0) && (
                            <div
                              data-testid={`hitl-panel-${thread.id}`}
                              className="p-3 bg-slate-950/70 border border-slate-800/80 rounded-lg space-y-2"
                            >
                              {thread.rationale && (
                                <p
                                  data-testid={`thread-rationale-${thread.id}`}
                                  className="text-xs text-slate-200 leading-relaxed"
                                >
                                  <span className="font-mono text-[11px] text-violet-300 font-semibold mr-1.5">
                                    Rationale:
                                  </span>
                                  {thread.rationale}
                                </p>
                              )}
                              {hitlReasons.length > 0 && (
                                <div
                                  data-testid={`hitl-reasons-${thread.id}`}
                                  className="flex flex-wrap items-center gap-1.5"
                                >
                                  <span className="text-[11px] font-mono text-amber-300">
                                    HITL Triggers:
                                  </span>
                                  {hitlReasons.map((reason) => (
                                    <span
                                      key={reason}
                                      data-testid={`hitl-reason-${thread.id}-${reason}`}
                                      className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/30 text-[10px] font-mono text-amber-200 rounded-full"
                                    >
                                      {reason}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* In-Place Draft Preview / Action Panel for draft_reply Threads (Send Gated) */}
                          {showDraftPanel && (
                            <div
                              data-testid={`draft-preview-panel-${thread.id}`}
                              className="p-3.5 bg-indigo-950/25 border border-indigo-500/30 rounded-lg space-y-2.5"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-mono font-semibold text-indigo-200">
                                    Prepared Gmail Reply Draft
                                  </span>
                                  {thread.draftId && (
                                    <span
                                      data-testid={`draft-id-badge-${thread.id}`}
                                      className="px-2 py-0.5 bg-indigo-500/20 border border-indigo-500/30 text-[10px] font-mono text-indigo-300 rounded"
                                    >
                                      Draft ID: {thread.draftId}
                                    </span>
                                  )}
                                  <span
                                    data-testid={`draft-send-gate-badge-${thread.id}`}
                                    className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/30 text-[10px] font-mono text-amber-200 rounded"
                                  >
                                    Send Gated · Owner Review Required
                                  </span>
                                </div>

                                <a
                                  href={buildGmailDraftUrl(thread)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  data-testid={`open-gmail-draft-${thread.id}`}
                                  className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-md transition-colors"
                                >
                                  Open Saved Draft in Gmail ↗
                                </a>
                              </div>

                              <pre
                                data-testid={`draft-reply-body-${thread.id}`}
                                className="p-2.5 bg-slate-950/90 border border-slate-800 rounded text-xs text-slate-200 font-sans whitespace-pre-wrap leading-relaxed"
                              >
                                {thread.draftReply ??
                                  "Draft prepared in Gmail; open draft to review before sending."}
                              </pre>
                            </div>
                          )}

                          {/* Linked Knowledge Graph Entities */}
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/70">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] font-mono text-slate-400">
                                Linked Entities:
                              </span>
                              {thread.linkedEntities.length === 0 ? (
                                <span className="text-[11px] font-mono text-slate-500">
                                  none
                                </span>
                              ) : (
                                thread.linkedEntities.map((entity) => (
                                  <button
                                    key={entity.id}
                                    type="button"
                                    data-testid={`entity-pill-${thread.id}-${entity.id}`}
                                    onClick={() => handleEntityClick(entity.id)}
                                    className={`px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors flex items-center gap-1 ${
                                      entity.hot
                                        ? "bg-amber-500/15 border-amber-500/40 text-amber-200 hover:bg-amber-500/25"
                                        : "bg-slate-950 border-slate-700 text-slate-300 hover:border-indigo-500/50 hover:text-indigo-200"
                                    }`}
                                  >
                                    {entity.hot && (
                                      <span
                                        className="text-[10px]"
                                        aria-hidden="true"
                                      >
                                        *
                                      </span>
                                    )}
                                    <span>{entity.title}</span>
                                    <span className="text-[10px] font-mono opacity-75">
                                      ({entity.entityType})
                                    </span>
                                  </button>
                                ))
                              )}
                            </div>

                            {thread.reasons && thread.reasons.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1">
                                {thread.reasons.map((reason) => (
                                  <span
                                    key={reason}
                                    className="px-1.5 py-0.2 bg-slate-950 border border-slate-800 text-[10px] font-mono text-slate-400 rounded"
                                  >
                                    {reason}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 4. Collapsible Sweep Audit Drawer (Grouped by ADR-118 Sweep Routes + Unsubscribe Batch + One-Click Correction) */}
      <section
        aria-label="Sweep audit drawer"
        data-testid="sweep-audit-drawer"
        className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden"
      >
        <div className="p-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white tracking-tight">
                Sweep Audit Drawer (Priority {MIN_EMAIL_PRIORITY}..
                {Math.max(MIN_EMAIL_PRIORITY, cutLine - 1)})
              </h3>
              <span className="px-2 py-0.5 bg-slate-800 text-slate-300 text-xs font-mono rounded-full">
                {partitioned.swept.length} swept
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Tier 2 lightweight decision log (`system_decisions`) grouped by ADR-118 sweep routes ({SWEPT_INBOX_ROUTES.join(", ")}). One-click correction overrides priority or intent and records a durable lesson via `/api/actions/review_lesson_record`.
            </p>
          </div>

          <button
            type="button"
            data-testid="sweep-audit-drawer-toggle"
            aria-expanded={sweepDrawerOpen}
            onClick={() => setSweepDrawerOpen((prev) => !prev)}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition-colors"
          >
            {sweepDrawerOpen
              ? `Hide Swept Threads (${partitioned.swept.length})`
              : `Inspect Swept Threads (${partitioned.swept.length})`}
          </button>
        </div>

        {sweepDrawerOpen && (
          <div className="p-4 space-y-5" data-testid="sweep-audit-drawer-content">
            {partitioned.swept.length === 0 ? (
              <div
                data-testid="swept-empty-state"
                className="p-6 text-center text-xs text-slate-400 bg-slate-950/50 border border-slate-800/60 rounded-lg"
              >
                No swept threads below priority {cutLine}+ for the selected filter.
              </div>
            ) : (
              SWEPT_INBOX_ROUTES.map((routeKey) => {
                const groupThreads = partitioned.sweptByRoute[routeKey];
                if (groupThreads.length === 0) {
                  return null;
                }
                const unprocessedInGroup = groupThreads.filter(
                  (t) => !processedThreadIds[t.id],
                );

                return (
                  <div
                    key={routeKey}
                    data-testid={`route-group-${routeKey}`}
                    className="space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                      <div className="flex items-center gap-2">
                        <span
                          data-testid={`route-group-header-${routeKey}`}
                          className="text-xs font-bold uppercase tracking-wider text-slate-200"
                        >
                          {EMAIL_ROUTE_TITLES[routeKey]} ({routeKey})
                        </span>
                        <span className="px-2 py-0.5 bg-slate-800 border border-slate-700 text-[11px] font-mono text-slate-300 rounded-full">
                          {groupThreads.length} thread(s)
                        </span>
                        <span className="text-[11px] font-mono text-slate-400">
                          Gmail Label: {EMAIL_ROUTE_LABELS[routeKey]}
                        </span>
                      </div>

                      {routeKey === "unsubscribe_candidate" && (
                        <div
                          data-testid="unsubscribe-batch-bar"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span className="text-[11px] font-mono text-fuchsia-300">
                            Label {GMAIL_UNSUBSCRIBE_LABEL} + Archive
                          </span>
                          <button
                            type="button"
                            disabled={
                              unsubscribingBatch || groupThreads.length === 0
                            }
                            data-testid="unsubscribe-batch-btn"
                            onClick={() =>
                              void handleUnsubscribeBatch(
                                unprocessedInGroup.length > 0
                                  ? unprocessedInGroup
                                  : groupThreads,
                              )
                            }
                            className="px-3 py-1.5 bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm"
                          >
                            {unsubscribingBatch
                              ? "Unsubscribing Batch..."
                              : `Unsubscribe & Archive Batch (${
                                  unprocessedInGroup.length > 0
                                    ? unprocessedInGroup.length
                                    : groupThreads.length
                                })`}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="space-y-3">
                      {groupThreads.map((thread) => {
                        const effectiveRoute = inferDefaultRouteForThread(
                          thread,
                          cutLine,
                        );
                        const effectiveThinkingMode =
                          thread.thinkingMode ?? "system_1";
                        const hitlReasons = thread.hitlReasons ?? [];
                        const selectedOverridePriority =
                          overridePriorityByThread[thread.id] ??
                          Math.max(cutLine, DEFAULT_PRIORITY_CUT_LINE);
                        const selectedOverrideIntent =
                          overrideIntentByThread[thread.id] ??
                          (thread.intentCategory === "marketing" ||
                          thread.intentCategory === "notification" ||
                          thread.intentCategory === "actioned"
                            ? "to_respond"
                            : thread.intentCategory);
                        const isCorrecting = correctingId === thread.id;

                        return (
                          <article
                            key={thread.id}
                            data-testid={`swept-thread-${thread.id}`}
                            data-priority={thread.priority}
                            data-domain={thread.domain}
                            data-intent={thread.intentCategory}
                            data-route={effectiveRoute}
                            data-thinking-mode={effectiveThinkingMode}
                            className="p-4 bg-slate-950/80 border border-slate-800/90 rounded-xl space-y-3"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  data-testid={`priority-badge-${thread.id}`}
                                  className={`px-2 py-0.5 text-xs font-mono font-bold rounded border ${getPriorityBadgeClasses(
                                    thread.priority,
                                  )}`}
                                >
                                  {formatPriorityBadge(
                                    clampEmailPriority(
                                      thread.priority,
                                    ) as PriorityLevel,
                                  )}
                                </span>

                                <span
                                  data-testid={`route-badge-${thread.id}`}
                                  className={`px-2 py-0.5 text-xs font-mono font-semibold rounded border ${getRouteBadgeClasses(
                                    effectiveRoute,
                                  )}`}
                                >
                                  {EMAIL_ROUTE_TITLES[effectiveRoute]} [
                                  {effectiveRoute}] ({EMAIL_ROUTE_LABELS[effectiveRoute]})
                                </span>

                                <span
                                  data-testid={`thinking-mode-badge-${thread.id}`}
                                  className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded border ${getThinkingModeBadgeClasses(
                                    effectiveThinkingMode,
                                  )}`}
                                >
                                  {effectiveThinkingMode === "system_2"
                                    ? "System 2 (Deep HITL)"
                                    : "System 1 (Fast Triage)"}{" "}
                                  [{effectiveThinkingMode}]
                                </span>

                                <span
                                  data-testid={`intent-badge-${thread.id}`}
                                  className={`px-2 py-0.5 text-xs font-medium rounded border ${getIntentBadgeClasses(
                                    thread.intentCategory,
                                  )}`}
                                >
                                  {INTENT_CATEGORY_LABELS[thread.intentCategory]}{" "}
                                  <span className="font-mono text-[10px] opacity-80">
                                    [{thread.intentCategory}]
                                  </span>
                                </span>

                                <span
                                  data-testid={`domain-pill-${thread.id}`}
                                  className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded-full border ${getDomainPillClasses(
                                    thread.domain,
                                  )}`}
                                >
                                  {thread.domain === "work"
                                    ? "Work"
                                    : "Personal"}{" "}
                                  ({thread.domain})
                                </span>

                                <span className="px-2 py-0.5 bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400 rounded">
                                  {thread.storageTier ?? "tier_2_decision_log"} /{" "}
                                  {thread.gmailAction ?? "sweep_archive"}
                                </span>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  aria-label={`Override priority for ${thread.subject}`}
                                  data-testid={`override-priority-select-${thread.id}`}
                                  value={selectedOverridePriority}
                                  onChange={(e) =>
                                    setOverridePriorityByThread((prev) => ({
                                      ...prev,
                                      [thread.id]: clampEmailPriority(
                                        Number(e.target.value),
                                      ),
                                    }))
                                  }
                                  className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 font-mono"
                                >
                                  {PRIORITY_SCALE_VALUES.map((score) => (
                                    <option key={score} value={score}>
                                      Promote to P{score}{" "}
                                      {
                                        getPriorityLevelDefinition(
                                          score as PriorityLevel,
                                        ).title
                                      }
                                    </option>
                                  ))}
                                </select>

                                <select
                                  aria-label={`Override intent for ${thread.subject}`}
                                  data-testid={`override-intent-select-${thread.id}`}
                                  value={selectedOverrideIntent}
                                  onChange={(e) =>
                                    setOverrideIntentByThread((prev) => ({
                                      ...prev,
                                      [thread.id]:
                                        e.target.value as EmailIntentCategory,
                                    }))
                                  }
                                  className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 font-mono"
                                >
                                  {EMAIL_INTENT_CATEGORIES.map((category) => (
                                    <option key={category} value={category}>
                                      {INTENT_CATEGORY_LABELS[category]} (
                                      {category})
                                    </option>
                                  ))}
                                </select>

                                <button
                                  type="button"
                                  disabled={isCorrecting}
                                  data-testid={`correct-thread-${thread.id}`}
                                  onClick={() =>
                                    handleOneClickCorrection(thread)
                                  }
                                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm"
                                >
                                  {isCorrecting
                                    ? "Recording Lesson..."
                                    : `One-Click Override (Promote P${selectedOverridePriority})`}
                                </button>
                              </div>
                            </div>

                            <div className="space-y-1">
                              <div className="text-xs font-mono text-slate-400">
                                From:{" "}
                                <span className="text-slate-200">
                                  {thread.sender}
                                </span>
                              </div>
                              <h4 className="text-sm font-semibold text-slate-100">
                                {thread.subject}
                              </h4>
                              <p className="text-xs text-slate-400 leading-relaxed">
                                {thread.snippet}
                              </p>
                            </div>

                            {(thread.rationale || hitlReasons.length > 0) && (
                              <div
                                data-testid={`hitl-panel-${thread.id}`}
                                className="p-2.5 bg-slate-900/70 border border-slate-800 rounded-lg space-y-1.5"
                              >
                                {thread.rationale && (
                                  <p
                                    data-testid={`thread-rationale-${thread.id}`}
                                    className="text-xs text-slate-300"
                                  >
                                    <span className="font-mono text-[11px] text-slate-400 font-semibold mr-1.5">
                                      Rationale:
                                    </span>
                                    {thread.rationale}
                                  </p>
                                )}
                                {hitlReasons.length > 0 && (
                                  <div
                                    data-testid={`hitl-reasons-${thread.id}`}
                                    className="flex flex-wrap items-center gap-1.5"
                                  >
                                    {hitlReasons.map((reason) => (
                                      <span
                                        key={reason}
                                        data-testid={`hitl-reason-${thread.id}-${reason}`}
                                        className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/30 text-[10px] font-mono text-amber-200 rounded-full"
                                      >
                                        {reason}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {thread.linkedEntities.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                <span className="text-[11px] font-mono text-slate-400">
                                  Linked Entities:
                                </span>
                                {thread.linkedEntities.map((entity) => (
                                  <button
                                    key={entity.id}
                                    type="button"
                                    data-testid={`entity-pill-${thread.id}-${entity.id}`}
                                    onClick={() => handleEntityClick(entity.id)}
                                    className="px-2 py-0.5 bg-slate-900 border border-slate-800 rounded-full text-[11px] text-slate-300 hover:border-indigo-500/40"
                                  >
                                    {entity.title} ({entity.entityType})
                                  </button>
                                ))}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </section>
    </div>
  );
}
export default PriorityInboxCanvas;

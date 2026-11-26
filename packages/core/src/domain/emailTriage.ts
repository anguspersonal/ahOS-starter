/**
 * @ahkms/core/domain - emailTriage.ts
 *
 * Pure domain model for native 3-tier priority email triage (Issue #1990, #2012):
 * - Three storage tiers: tier_1_gmail_only, tier_2_decision_log, tier_3_full_artifact
 * - Eight orthogonal semantic intent categories
 * - 1..7 priority scoring enriched by knowledge graph context
 * - Curated inbox partitioning and dynamic sweep rules
 */

import { z } from "zod";
import { ARTIFACT_SURFACES } from "./artifacts.js";
import { DAILY_EMAIL_FLOW_CONTENT_SUBTYPE } from "./vocab.js";

export const EMAIL_INTENT_CATEGORIES = [
	"to_respond",
	"fyi",
	"comment",
	"notification",
	"meeting_update",
	"awaiting_reply",
	"actioned",
	"marketing",
] as const;

export const emailIntentCategorySchema = z.enum(EMAIL_INTENT_CATEGORIES);

export type EmailIntentCategory = (typeof EMAIL_INTENT_CATEGORIES)[number];

export const EMAIL_STORAGE_TIERS = [
	"tier_1_gmail_only",
	"tier_2_decision_log",
	"tier_3_full_artifact",
] as const;

export const emailStorageTierSchema = z.enum(EMAIL_STORAGE_TIERS);

export type EmailStorageTier = (typeof EMAIL_STORAGE_TIERS)[number];

export const GMAIL_SWEEP_ACTIONS = ["keep_inbox", "sweep_archive"] as const;

export const gmailSweepActionSchema = z.enum(GMAIL_SWEEP_ACTIONS);

export type GmailSweepAction = (typeof GMAIL_SWEEP_ACTIONS)[number];

export const MIN_EMAIL_PRIORITY = 1;
export const MAX_EMAIL_PRIORITY = 7;
export const DEFAULT_PRIORITY_CUT_LINE = 5;

export const BASE_PRIORITY_BY_INTENT: Readonly<Record<EmailIntentCategory, number>> = Object.freeze({
	to_respond: 5,
	meeting_update: 4,
	awaiting_reply: 4,
	comment: 3,
	fyi: 3,
	notification: 2,
	actioned: 2,
	marketing: 1,
});

export interface GmailTriageGraphContext {
	/** Matched hot entities in the knowledge graph (IDs/names or count). */
	matchedHotEntities?: readonly string[] | number;
	/** Matched key people / VIPs in the knowledge graph (IDs/names or count). */
	keyPeople?: readonly string[] | number;
	/** Matched active / open tasks linked to the thread or sender (IDs/titles or count). */
	activeTasks?: readonly string[] | number;
	/** Matched active projects linked to the thread or sender (IDs/names or count). */
	activeProjects?: readonly string[] | number;
	/** Explicit flag when the sender is a known key person / VIP. */
	isKeyPerson?: boolean;
	/** Whether an open thread is awaiting a reply or follow-up. */
	pendingReply?: boolean;
	/** The graph's relationship label for the sender (e.g. "co-founder"), ADR-118. */
	relationship?: string | null;
	/** Matched `people.id` when the sender resolved to a person in the graph. */
	contactId?: string | null;
	/** True when the sender matched a `people` row by name whose `email` column is still null. */
	contactMissingEmail?: boolean;
}

export interface EmailPriorityScoringInput {
	intentCategory?: EmailIntentCategory;
	/** Optional explicit base priority (1..7) before signal and graph adjustments. */
	basePriority?: number;
	/** Whether the user is a direct recipient (To:) rather than CC/BCC/list. */
	isDirectRecipient?: boolean;
	/** Whether the message contains explicit urgency or deadline cues. */
	hasUrgencyCue?: boolean;
	/** Whether the sender is an automated / bulk / no-reply address. */
	isAutomatedSender?: boolean;
	/** Whether the thread is known noise / unsubscribed digest / spam. */
	isNoise?: boolean;
	/** Optional subject line for lightweight cue detection. */
	subject?: string;
	/** Optional snippet text for lightweight cue detection. */
	snippet?: string;
	/** Optional sender address or display string for automated-sender detection. */
	sender?: string;
	/** Nested knowledge graph context for priority enrichment. */
	graphContext?: GmailTriageGraphContext;
	/** Top-level convenience graph context fields. */
	matchedHotEntities?: readonly string[] | number;
	keyPeople?: readonly string[] | number;
	activeTasks?: readonly string[] | number;
	activeProjects?: readonly string[] | number;
	isKeyPerson?: boolean;
	pendingReply?: boolean;
}

export interface EmailPriorityEvaluation {
	priority: number;
	baseScore: number;
	graphBoost: number;
	reasons: string[];
}

export interface ClassifyEmailTriageOptions {
	confidence?: number;
	/** Whether high-priority (>= cutLine) items exist in the current inbox batch (default true). */
	hasHighPriorityItems?: boolean;
	/** When true for below-cut-line noise, keeps the thread in Tier 1 without logging Tier 2. */
	skipDecisionLog?: boolean;
}

export interface EmailTriageTierClassification {
	priority: number;
	cutLine: number;
	confidence: number;
	storageTier: EmailStorageTier;
	gmailAction: GmailSweepAction;
	promoteToArtifact: boolean;
}

export interface PartitionableTriageDecision {
	priority: number;
	receivedAt?: string | number | Date | null;
	received_at?: string | number | Date | null;
	timestamp?: string | number | Date | null;
	createdAt?: string | number | Date | null;
	created_at?: string | number | Date | null;
}

export interface PartitionedCuratedInbox<T> {
	curated: T[];
	swept: T[];
	shouldSweepLowPriority: boolean;
}

const URGENCY_CUE_PATTERN =
	/\b(urgent|asap|deadline|action required|immediately|overdue|blocking|time[- ]sensitive)\b/i;

const AUTOMATED_SENDER_PATTERN =
	/\b(no-?reply|donotreply|automated|notifications?@|digest@|newsletter@|mailer-daemon)\b/i;

/**
 * Clamp any numeric priority score to an integer in the universal 1..7 range.
 */
export function clampEmailPriority(priority: number): number {
	if (!Number.isFinite(priority)) {
		return MIN_EMAIL_PRIORITY;
	}
	const rounded = Math.round(priority);
	return Math.min(MAX_EMAIL_PRIORITY, Math.max(MIN_EMAIL_PRIORITY, rounded));
}

function clampConfidence(confidence: number | undefined): number {
	if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
		return 1;
	}
	return Math.min(1, Math.max(0, confidence));
}

function countSignalItems(value: readonly string[] | number | undefined): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.floor(value));
	}
	if (Array.isArray(value)) {
		return value.filter((item) => typeof item === "string" && item.trim().length > 0).length;
	}
	return 0;
}

/**
 * Evaluate email priority on the 1..7 scale with detailed breakdown of base score,
 * graph-context boost, and human-readable scoring reasons.
 */
export function evaluateEmailPriority(input: EmailPriorityScoringInput): EmailPriorityEvaluation {
	const reasons: string[] = [];

	let baseScore = 3;
	if (typeof input.basePriority === "number" && Number.isFinite(input.basePriority)) {
		baseScore = input.basePriority;
		reasons.push(`base_priority:${input.basePriority}`);
	} else if (input.intentCategory && input.intentCategory in BASE_PRIORITY_BY_INTENT) {
		baseScore = BASE_PRIORITY_BY_INTENT[input.intentCategory];
		reasons.push(`intent:${input.intentCategory}`);
	}

	let messageDelta = 0;

	if (input.isDirectRecipient === true) {
		messageDelta += 1;
		reasons.push("direct_recipient");
	} else if (input.isDirectRecipient === false) {
		messageDelta -= 1;
		reasons.push("indirect_recipient");
	}

	const combinedText = `${input.subject ?? ""} ${input.snippet ?? ""}`.trim();
	const hasUrgency =
		input.hasUrgencyCue === true ||
		(input.hasUrgencyCue === undefined && URGENCY_CUE_PATTERN.test(combinedText));
	if (hasUrgency) {
		messageDelta += 1;
		reasons.push("urgency_cue");
	}

	const isAutomated =
		input.isAutomatedSender === true ||
		(input.isAutomatedSender === undefined &&
			typeof input.sender === "string" &&
			AUTOMATED_SENDER_PATTERN.test(input.sender));
	if (isAutomated) {
		messageDelta -= 1;
		reasons.push("automated_sender");
	}

	if (input.isNoise === true) {
		messageDelta -= 2;
		reasons.push("noise_signal");
	}

	const graph = input.graphContext;
	const hotEntitiesCount = countSignalItems(
		input.matchedHotEntities ?? graph?.matchedHotEntities,
	);
	const keyPeopleCount = countSignalItems(input.keyPeople ?? graph?.keyPeople);
	const activeTasksCount = countSignalItems(input.activeTasks ?? graph?.activeTasks);
	const activeProjectsCount = countSignalItems(
		input.activeProjects ?? graph?.activeProjects,
	);
	const isKeyPerson = Boolean(
		input.isKeyPerson ?? graph?.isKeyPerson ?? keyPeopleCount > 0,
	);
	const pendingReply = Boolean(input.pendingReply ?? graph?.pendingReply);

	let graphBoost = 0;

	if (hotEntitiesCount > 0) {
		const boost = hotEntitiesCount >= 2 ? 2 : 1;
		graphBoost += boost;
		reasons.push(`matched_hot_entities:${hotEntitiesCount}`);
	}

	if (isKeyPerson) {
		graphBoost += 1;
		reasons.push("key_person");
	}

	if (activeTasksCount > 0) {
		graphBoost += 1;
		reasons.push(`active_tasks:${activeTasksCount}`);
	}

	if (activeProjectsCount > 0) {
		graphBoost += 1;
		reasons.push(`active_projects:${activeProjectsCount}`);
	}

	if (pendingReply) {
		graphBoost += 1;
		reasons.push("pending_reply");
	}

	const priority = clampEmailPriority(baseScore + messageDelta + graphBoost);

	return {
		priority,
		baseScore,
		graphBoost,
		reasons,
	};
}

/**
 * Compute a clamped 1..7 integer priority score from base message signals
 * and knowledge graph context.
 */
export function scoreEmailPriority(input: EmailPriorityScoringInput): number {
	return evaluateEmailPriority(input).priority;
}

/**
 * Classify an email's storage tier and Gmail sweep action given its 1..7 priority
 * and configurable priority cut-line (default 5).
 */
export function classifyEmailTriageTier(
	priority: number,
	cutLine: number = DEFAULT_PRIORITY_CUT_LINE,
	confidenceOrOptions: number | ClassifyEmailTriageOptions = 1,
): EmailTriageTierClassification {
	const clampedPriority = clampEmailPriority(priority);
	const effectiveCutLine = clampEmailPriority(cutLine);

	const options: ClassifyEmailTriageOptions =
		typeof confidenceOrOptions === "number"
			? { confidence: confidenceOrOptions }
			: confidenceOrOptions;

	const confidence = clampConfidence(options.confidence);
	const hasHighPriorityItems = options.hasHighPriorityItems ?? true;
	const skipDecisionLog = options.skipDecisionLog ?? false;

	if (clampedPriority >= effectiveCutLine) {
		return {
			priority: clampedPriority,
			cutLine: effectiveCutLine,
			confidence,
			storageTier: "tier_3_full_artifact",
			gmailAction: "keep_inbox",
			promoteToArtifact: true,
		};
	}

	return {
		priority: clampedPriority,
		cutLine: effectiveCutLine,
		confidence,
		storageTier: skipDecisionLog ? "tier_1_gmail_only" : "tier_2_decision_log",
		gmailAction: hasHighPriorityItems ? "sweep_archive" : "keep_inbox",
		promoteToArtifact: false,
	};
}

function resolveDecisionTimestampMs(item: PartitionableTriageDecision): number {
	const raw =
		item.receivedAt ??
		item.received_at ??
		item.timestamp ??
		item.createdAt ??
		item.created_at ??
		null;
	if (raw === null || raw === undefined) {
		return 0;
	}
	if (raw instanceof Date) {
		const ms = raw.getTime();
		return Number.isFinite(ms) ? ms : 0;
	}
	if (typeof raw === "number") {
		return Number.isFinite(raw) ? raw : 0;
	}
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

/**
 * Partition evaluated email triage decisions into:
 * - `curated`: uncapped high-priority threads (`priority >= cutLine`), sorted descending
 *   by priority and then newest-first.
 * - `swept`: lower-priority threads (`priority < cutLine`), sorted newest-first.
 * - `shouldSweepLowPriority`: true when at least one high-priority thread exists (`curated.length > 0`).
 */
export function partitionCuratedInbox<T extends PartitionableTriageDecision>(
	decisions: readonly T[],
	cutLine: number = DEFAULT_PRIORITY_CUT_LINE,
): PartitionedCuratedInbox<T> {
	const effectiveCutLine = clampEmailPriority(cutLine);
	const curated: T[] = [];
	const swept: T[] = [];

	for (const decision of decisions) {
		if (clampEmailPriority(decision.priority) >= effectiveCutLine) {
			curated.push(decision);
		} else {
			swept.push(decision);
		}
	}

	curated.sort((a, b) => {
		const priorityDiff = clampEmailPriority(b.priority) - clampEmailPriority(a.priority);
		if (priorityDiff !== 0) {
			return priorityDiff;
		}
		return resolveDecisionTimestampMs(b) - resolveDecisionTimestampMs(a);
	});

	swept.sort((a, b) => {
		const timeDiff = resolveDecisionTimestampMs(b) - resolveDecisionTimestampMs(a);
		if (timeDiff !== 0) {
			return timeDiff;
		}
		return clampEmailPriority(b.priority) - clampEmailPriority(a.priority);
	});

	return {
		curated,
		swept,
		shouldSweepLowPriority: curated.length > 0,
	};
}

// ---- Daily Email Flow Waterfall Metrics (Unread & Processed per Inbox + Combined) ----

/** Canonical Gmail query defining the unread inbox stock (`in:inbox is:unread`). */
export const DAILY_EMAIL_FLOW_UNREAD_QUERY = "in:inbox is:unread" as const;

/** Canonical stock-and-flow waterfall formula for daily unread & processed email tracking. */
export const DAILY_EMAIL_FLOW_FORMULA =
	"End = Starting + New Today - Processed Today" as const;

export const DAILY_EMAIL_FLOW_ACCOUNTS = [
	"personal",
	"work",
	"all",
] as const;

export const dailyEmailFlowAccountSchema = z.enum(DAILY_EMAIL_FLOW_ACCOUNTS);

export type DailyEmailFlowAccount =
	(typeof DAILY_EMAIL_FLOW_ACCOUNTS)[number];

export interface DailyInboxFlowMetrics {
	/** Mailbox scope: `'personal'` (`angus`), `'work'`, or `'all'` (combined). */
	account: DailyEmailFlowAccount;
	/** Unread inbox threads at the start of the day (or chained from prior day's `end`). */
	starting: number;
	/** New inbox threads received today. */
	new_today: number;
	/** Threads processed today (marked read or archived/swept out of Inbox). */
	processed_today: number;
	/** Unread threads remaining in Inbox (`in:inbox is:unread`). */
	end: number;
	/** Net change in unread Inbox count today (`end - starting`; negative means Inbox is shrinking). */
	net_delta: number;
	/** Portion of `processed_today` swept/archived automatically by ahOS triage. */
	swept_today: number;
	/** Portion of `processed_today` marked read or archived manually or via workflow reconciliation. */
	manual_or_reconciled_today: number;
	/** Daily inflow clearance rate (`round((processed_today / new_today) * 100, 1)`), >100% when burning down backlog. */
	clearance_rate_pct: number;
}

export const dailyInboxFlowMetricsSchema = z.object({
	account: dailyEmailFlowAccountSchema,
	starting: z.number().int().min(0),
	new_today: z.number().int().min(0),
	processed_today: z.number().int().min(0),
	end: z.number().int().min(0),
	net_delta: z.number().int(),
	swept_today: z.number().int().min(0),
	manual_or_reconciled_today: z.number().int().min(0),
	clearance_rate_pct: z.number().min(0),
});

export interface DailyEmailFlowTrendPoint {
	/** UTC date key (`YYYY-MM-DD`). */
	date_key: string;
	personal: DailyInboxFlowMetrics;
	work: DailyInboxFlowMetrics;
	combined: DailyInboxFlowMetrics;
}

export const dailyEmailFlowTrendPointSchema = z.object({
	date_key: z.string().min(1),
	personal: dailyInboxFlowMetricsSchema,
	work: dailyInboxFlowMetricsSchema,
	combined: dailyInboxFlowMetricsSchema,
});

export interface DailyEmailFlowSnapshot {
	/** UTC calendar date key (`YYYY-MM-DD`). */
	date_key: string;
	/** ISO-8601 timestamp when the snapshot was computed. */
	generated_at: string;
	/** Unread pool scope query (`in:inbox is:unread`). */
	unread_query: string;
	/** Stock-and-flow waterfall formula (`End = Starting + New Today - Processed Today`). */
	formula: string;
	/** Personal (`angus`) mailbox daily flow metrics. */
	personal: DailyInboxFlowMetrics;
	/** Work (`work`) mailbox daily flow metrics. */
	work: DailyInboxFlowMetrics;
	/** Combined (`personal + work`) daily flow metrics. */
	combined: DailyInboxFlowMetrics;
	/** Optional multi-day trend series showing `processed_today` going up and `end` going down. */
	history?: DailyEmailFlowTrendPoint[];
}

export const dailyEmailFlowSnapshotSchema = z.object({
	date_key: z.string().min(1),
	generated_at: z.string().min(1),
	unread_query: z.string().min(1),
	formula: z.string().min(1),
	personal: dailyInboxFlowMetricsSchema,
	work: dailyInboxFlowMetricsSchema,
	combined: dailyInboxFlowMetricsSchema,
	history: z.array(dailyEmailFlowTrendPointSchema).optional(),
});

export interface ComputeDailyInboxFlowInput {
	account: DailyEmailFlowAccount;
	/** Unread inbox count at start of day. When omitted, falls back to `previous_day_end` or derives from waterfall. */
	starting?: number;
	/** Previous day's `end` unread inbox count (chains `Day[t].starting = Day[t-1].end`). */
	previous_day_end?: number;
	/** Threads arriving in the inbox today. */
	new_today?: number;
	/** Threads processed today (marked read or archived out of Inbox). */
	processed_today?: number;
	/** Current / end-of-day unread threads in Inbox (`in:inbox is:unread`). */
	end?: number;
	/** Threads swept/archived by ahOS triage today. */
	swept_today?: number;
	/** Threads marked read or archived manually / via reconciliation today. */
	manual_or_reconciled_today?: number;
	/**
	 * When true and `starting`, `new_today`, `processed_today`, and `end` are all explicitly passed
	 * (e.g., pinning an initial Day-1 mid-day baseline such as `Starting 250, New Today 40, Processed 0, End 250`),
	 * preserves the caller's explicit `starting` and `end` counts while still tracking subsequent processed deltas.
	 */
	preserve_explicit_baseline?: boolean;
}

export interface DailyEmailFlowDayInput {
	date_key: string;
	personal: Omit<ComputeDailyInboxFlowInput, "account">;
	work: Omit<ComputeDailyInboxFlowInput, "account">;
}

export interface BuildDailyEmailFlowSnapshotInput {
	date_key?: string;
	generated_at?: string;
	personal: Omit<ComputeDailyInboxFlowInput, "account">;
	work: Omit<ComputeDailyInboxFlowInput, "account">;
	history?: DailyEmailFlowTrendPoint[];
}

function clampNonNegativeInt(value: number | undefined, fallback = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return Math.max(0, Math.round(fallback));
	}
	return Math.max(0, Math.round(value));
}

function computeClearanceRatePct(
	processedToday: number,
	newToday: number,
): number {
	if (newToday > 0) {
		return Math.round((processedToday / newToday) * 1000) / 10;
	}
	return processedToday > 0 ? 100 : 0;
}

/**
 * Formats a `Date` or ISO timestamp into a UTC calendar date key (`YYYY-MM-DD`).
 */
export function computeUtcDateKey(date: Date | string = new Date()): string {
	const d =
		typeof date === "string"
			? new Date(date)
			: date instanceof Date
				? date
				: new Date();
	const validDate = Number.isFinite(d.getTime()) ? d : new Date();
	const year = validDate.getUTCFullYear();
	const month = String(validDate.getUTCMonth() + 1).padStart(2, "0");
	const day = String(validDate.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Computes daily unread & processed email flow metrics for a single inbox (`personal`, `work`)
 * or `all`, enforcing the stock-and-flow waterfall formula:
 *
 *   `End = Starting + New Today - Processed Today`
 *
 * Supports:
 * - Chaining `starting` from `previous_day_end` (`Day[t].starting = Day[t-1].end`)
 * - Deriving `end` from `starting + new_today - processed_today`
 * - Deriving `processed_today` from `starting + new_today - end` when live `end` is measured
 * - Deriving `starting` from `end - new_today + processed_today` when bootstrapping without prior baseline
 * - Optional `preserve_explicit_baseline` for Day-1 mid-day baseline pinning
 */
export function computeDailyInboxFlowMetrics(
	input: ComputeDailyInboxFlowInput,
): DailyInboxFlowMetrics {
	let newToday = clampNonNegativeInt(input.new_today, 0);
	const rawSwept = clampNonNegativeInt(input.swept_today, 0);
	const rawManual =
		input.manual_or_reconciled_today !== undefined
			? clampNonNegativeInt(input.manual_or_reconciled_today, 0)
			: undefined;

	const hasExplicitStarting =
		typeof input.starting === "number" && Number.isFinite(input.starting);
	const hasPreviousDayEnd =
		typeof input.previous_day_end === "number" &&
		Number.isFinite(input.previous_day_end);
	const hasStarting = hasExplicitStarting || hasPreviousDayEnd;
	const hasProcessed =
		typeof input.processed_today === "number" &&
		Number.isFinite(input.processed_today);
	const hasEnd = typeof input.end === "number" && Number.isFinite(input.end);

	let starting = 0;
	let processedToday = 0;
	let end = 0;

	if (
		input.preserve_explicit_baseline === true &&
		hasStarting &&
		hasProcessed &&
		hasEnd
	) {
		starting = clampNonNegativeInt(input.starting ?? input.previous_day_end, 0);
		processedToday = clampNonNegativeInt(input.processed_today, 0);
		end = clampNonNegativeInt(input.end, 0);
	} else if (hasStarting && hasProcessed && !hasEnd) {
		starting = clampNonNegativeInt(input.starting ?? input.previous_day_end, 0);
		processedToday = clampNonNegativeInt(input.processed_today, 0);
		end = Math.max(0, starting + newToday - processedToday);
	} else if (hasStarting && hasEnd && !hasProcessed) {
		starting = clampNonNegativeInt(input.starting ?? input.previous_day_end, 0);
		end = clampNonNegativeInt(input.end, 0);
		processedToday = Math.max(
			rawSwept + (rawManual ?? 0),
			starting + newToday - end,
		);
		if (starting + newToday - processedToday < end) {
			newToday = end + processedToday - starting;
		}
	} else if (!hasStarting && hasEnd) {
		end = clampNonNegativeInt(input.end, 0);
		processedToday = hasProcessed
			? clampNonNegativeInt(input.processed_today, 0)
			: rawSwept + (rawManual ?? 0);
		starting = Math.max(0, end - newToday + processedToday);
	} else if (hasStarting && hasProcessed && hasEnd) {
		starting = clampNonNegativeInt(input.starting ?? input.previous_day_end, 0);
		processedToday = clampNonNegativeInt(input.processed_today, 0);
		end = Math.max(0, starting + newToday - processedToday);
	} else if (hasStarting) {
		starting = clampNonNegativeInt(input.starting ?? input.previous_day_end, 0);
		processedToday = rawSwept + (rawManual ?? 0);
		end = Math.max(0, starting + newToday - processedToday);
	} else {
		processedToday = hasProcessed
			? clampNonNegativeInt(input.processed_today, 0)
			: rawSwept + (rawManual ?? 0);
		starting = 0;
		end = Math.max(0, starting + newToday - processedToday);
	}

	const sweptToday = Math.min(processedToday, rawSwept);
	const manualOrReconciledToday =
		rawManual !== undefined
			? Math.min(Math.max(0, processedToday - sweptToday), rawManual)
			: Math.max(0, processedToday - sweptToday);
	const netDelta = end - starting;
	const clearanceRatePct = computeClearanceRatePct(processedToday, newToday);

	return {
		account: input.account,
		starting,
		new_today: newToday,
		processed_today: processedToday,
		end,
		net_delta: netDelta,
		swept_today: sweptToday,
		manual_or_reconciled_today: manualOrReconciledToday,
		clearance_rate_pct: clearanceRatePct,
	};
}

/**
 * Aggregates separate `personal` (`angus`) and `work` daily inbox flow metrics
 * into the `combined` (`all`) inbox flow metrics while preserving the waterfall identity:
 * `combined.end = combined.starting + combined.new_today - combined.processed_today`.
 */
export function computeCombinedDailyEmailFlow(
	personal: DailyInboxFlowMetrics,
	work: DailyInboxFlowMetrics,
): DailyInboxFlowMetrics {
	const starting = personal.starting + work.starting;
	const newToday = personal.new_today + work.new_today;
	const processedToday = personal.processed_today + work.processed_today;
	const end = personal.end + work.end;
	const sweptToday = personal.swept_today + work.swept_today;
	const manualOrReconciledToday =
		personal.manual_or_reconciled_today + work.manual_or_reconciled_today;
	const netDelta = end - starting;
	const clearanceRatePct = computeClearanceRatePct(processedToday, newToday);

	return {
		account: "all",
		starting,
		new_today: newToday,
		processed_today: processedToday,
		end,
		net_delta: netDelta,
		swept_today: sweptToday,
		manual_or_reconciled_today: manualOrReconciledToday,
		clearance_rate_pct: clearanceRatePct,
	};
}

/**
 * Applies a delta to `processed_today` (e.g. `+1` when an unread inbox thread is processed/swept,
 * or `-1` when a swept thread is promoted back to the active Inbox) so that `processed_today`
 * goes up and `end` goes down by the exact same amount.
 */
export function applyProcessedDeltaToInboxFlow(
	metrics: DailyInboxFlowMetrics,
	deltaProcessed: number,
	options: { isSwept?: boolean } = {},
): DailyInboxFlowMetrics {
	const roundedDelta = Math.round(deltaProcessed);
	if (roundedDelta === 0 || !Number.isFinite(roundedDelta)) {
		return { ...metrics };
	}

	const nextProcessed = Math.max(0, metrics.processed_today + roundedDelta);
	const effectiveDelta = nextProcessed - metrics.processed_today;
	const waterfallMatches =
		metrics.end ===
		Math.max(0, metrics.starting + metrics.new_today - metrics.processed_today);

	const nextEnd = waterfallMatches
		? Math.max(0, metrics.starting + metrics.new_today - nextProcessed)
		: Math.max(0, metrics.end - effectiveDelta);

	const isSwept = options.isSwept ?? false;
	const nextSwept = isSwept
		? Math.min(nextProcessed, Math.max(0, metrics.swept_today + effectiveDelta))
		: Math.min(nextProcessed, metrics.swept_today);
	const nextManual = Math.max(0, nextProcessed - nextSwept);

	return {
		...metrics,
		processed_today: nextProcessed,
		end: nextEnd,
		net_delta: nextEnd - metrics.starting,
		swept_today: nextSwept,
		manual_or_reconciled_today: nextManual,
		clearance_rate_pct: computeClearanceRatePct(
			nextProcessed,
			metrics.new_today,
		),
	};
}

/**
 * Applies a processed-thread delta to a specific inbox (`personal` or `work`) inside a
 * `DailyEmailFlowSnapshot` and recomputes the `combined` (`all`) metrics automatically.
 */
export function applyProcessedDeltaToSnapshot(
	snapshot: DailyEmailFlowSnapshot,
	account: "personal" | "work",
	deltaProcessed: number,
	options: { isSwept?: boolean } = {},
): DailyEmailFlowSnapshot {
	const nextPersonal =
		account === "personal"
			? applyProcessedDeltaToInboxFlow(
					snapshot.personal,
					deltaProcessed,
					options,
				)
			: snapshot.personal;
	const nextWork =
		account === "work"
			? applyProcessedDeltaToInboxFlow(
					snapshot.work,
					deltaProcessed,
					options,
				)
			: snapshot.work;
	const nextCombined = computeCombinedDailyEmailFlow(nextPersonal, nextWork);

	const nextHistory = snapshot.history?.map((point) =>
		point.date_key === snapshot.date_key
			? {
					...point,
					personal: nextPersonal,
					work: nextWork,
					combined: nextCombined,
				}
			: point,
	);

	return {
		...snapshot,
		personal: nextPersonal,
		work: nextWork,
		combined: nextCombined,
		...(nextHistory ? { history: nextHistory } : {}),
	};
}

/**
 * Chains a chronological sequence of daily inbox inputs so that each day's `starting`
 * automatically inherits the prior day's `end` (`Day[t].starting = Day[t-1].end`)
 * unless explicitly overridden, producing both per-inbox (`personal`, `work`) and
 * `combined` (`all`) metrics for every day.
 */
export function chainDailyEmailFlowSeries(
	days: readonly DailyEmailFlowDayInput[],
): DailyEmailFlowTrendPoint[] {
	const points: DailyEmailFlowTrendPoint[] = [];
	let prevPersonalEnd: number | undefined;
	let prevWorkEnd: number | undefined;

	for (const day of days) {
		const personal = computeDailyInboxFlowMetrics({
			account: "personal",
			...day.personal,
			previous_day_end: day.personal.previous_day_end ?? prevPersonalEnd,
		});
		const work = computeDailyInboxFlowMetrics({
			account: "work",
			...day.work,
			previous_day_end: day.work.previous_day_end ?? prevWorkEnd,
		});
		const combined = computeCombinedDailyEmailFlow(personal, work);

		points.push({
			date_key: day.date_key,
			personal,
			work,
			combined,
		});

		prevPersonalEnd = personal.end;
		prevWorkEnd = work.end;
	}

	return points;
}

/**
 * Builds a complete `DailyEmailFlowSnapshot` tracking `personal` (`angus`), `work`,
 * and `combined` (`all`) daily unread & processed email flow metrics.
 */
export function buildDailyEmailFlowSnapshot(
	input: BuildDailyEmailFlowSnapshotInput,
): DailyEmailFlowSnapshot {
	const generatedAt = input.generated_at ?? new Date().toISOString();
	const dateKey = input.date_key ?? computeUtcDateKey(generatedAt);

	const personal = computeDailyInboxFlowMetrics({
		account: "personal",
		...input.personal,
	});
	const work = computeDailyInboxFlowMetrics({
		account: "work",
		...input.work,
	});
	const combined = computeCombinedDailyEmailFlow(personal, work);

	return {
		date_key: dateKey,
		generated_at: generatedAt,
		unread_query: DAILY_EMAIL_FLOW_UNREAD_QUERY,
		formula: DAILY_EMAIL_FLOW_FORMULA,
		personal,
		work,
		combined,
		...(input.history ? { history: input.history } : {}),
	};
}

/**
 * Returns the canonical `artifacts.dedup_key` for a given UTC date key (`kpi_email_daily:<YYYY-MM-DD>`).
 */
export function computeDailyEmailFlowDedupKey(dateKey: string): string {
	return `kpi_email_daily:${dateKey.trim()}`;
}

/**
 * Renders a Markdown scorecard table for a `DailyEmailFlowSnapshot` across
 * Personal (`angus`), Work (`work`), and Combined (`all`).
 */
export function renderDailyEmailFlowMarkdown(
	snapshot: DailyEmailFlowSnapshot,
): string {
	const formatDelta = (delta: number): string =>
		delta > 0 ? `+${delta}` : `${delta}`;
	return [
		`# Daily Email Flow Scorecard — ${snapshot.date_key}`,
		"",
		`Formula: \`${snapshot.formula}\` · Unread Scope: \`${snapshot.unread_query}\``,
		"",
		"| Inbox | Starting | New Today | Processed | End | Net Delta | Clearance |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
		`| Personal (angus) | ${snapshot.personal.starting} | +${snapshot.personal.new_today} | ${snapshot.personal.processed_today} | ${snapshot.personal.end} | ${formatDelta(snapshot.personal.net_delta)} | ${snapshot.personal.clearance_rate_pct}% |`,
		`| Work (work) | ${snapshot.work.starting} | +${snapshot.work.new_today} | ${snapshot.work.processed_today} | ${snapshot.work.end} | ${formatDelta(snapshot.work.net_delta)} | ${snapshot.work.clearance_rate_pct}% |`,
		`| **Combined (All)** | **${snapshot.combined.starting}** | **+${snapshot.combined.new_today}** | **${snapshot.combined.processed_today}** | **${snapshot.combined.end}** | **${formatDelta(snapshot.combined.net_delta)}** | **${snapshot.combined.clearance_rate_pct}%** |`,
	].join("\n");
}

export interface DailyEmailFlowCapturePayload {
	title: string;
	text: string;
	content_subtype: typeof DAILY_EMAIL_FLOW_CONTENT_SUBTYPE;
	surface: typeof ARTIFACT_SURFACES.kpiSnapshot;
	dedup_key: string;
	tags: string[];
	processing_metadata: {
		derivation: { status: "skipped"; reason: "role_metrics" };
		zero_commitments: true;
		date_key: string;
		daily_email_flow: DailyEmailFlowSnapshot;
	};
}

/**
 * Builds the canonical `capture` action payload to persist or update a `DailyEmailFlowSnapshot`
 * in `public.artifacts` (`surface = 'kpi_snapshot'`, `content_subtype = 'daily_email_flow_scorecard'`,
 * `dedup_key = 'kpi_email_daily:<YYYY-MM-DD>'`).
 */
export function buildDailyEmailFlowCapturePayload(
	snapshot: DailyEmailFlowSnapshot,
): DailyEmailFlowCapturePayload {
	return {
		title: `Daily Email Flow Scorecard — ${snapshot.date_key}`,
		text: renderDailyEmailFlowMarkdown(snapshot),
		content_subtype: DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
		surface: ARTIFACT_SURFACES.kpiSnapshot,
		dedup_key: computeDailyEmailFlowDedupKey(snapshot.date_key),
		tags: [
			"metrics",
			"kpi_snapshot",
			"email_flow",
			`date:${snapshot.date_key}`,
		],
		processing_metadata: {
			derivation: { status: "skipped", reason: "role_metrics" },
			zero_commitments: true,
			date_key: snapshot.date_key,
			daily_email_flow: snapshot,
		},
	};
}

/**
 * Parses a stored `public.artifacts` row (`content_subtype = 'daily_email_flow_scorecard'`)
 * back into a validated `DailyEmailFlowSnapshot`.
 */
export function parseStoredDailyEmailFlowArtifact(
	row: Record<string, unknown> | null | undefined,
): DailyEmailFlowSnapshot | null {
	if (!row || typeof row !== "object") {
		return null;
	}
	const meta =
		row.processing_metadata && typeof row.processing_metadata === "object"
			? (row.processing_metadata as Record<string, unknown>)
			: null;
	if (!meta) {
		return null;
	}
	const rawFlow =
		meta.daily_email_flow && typeof meta.daily_email_flow === "object"
			? (meta.daily_email_flow as Record<string, unknown>)
			: null;
	if (!rawFlow) {
		return null;
	}

	const directParsed = dailyEmailFlowSnapshotSchema.safeParse(rawFlow);
	if (directParsed.success) {
		return directParsed.data;
	}

	const rawPersonal =
		rawFlow.personal && typeof rawFlow.personal === "object"
			? (rawFlow.personal as Record<string, unknown>)
			: null;
	const rawWork =
		rawFlow.work && typeof rawFlow.work === "object"
			? (rawFlow.work as Record<string, unknown>)
			: null;
	if (!rawPersonal || !rawWork) {
		return null;
	}

	const dedupKey =
		typeof row.dedup_key === "string" && row.dedup_key.trim().length > 0
			? row.dedup_key.trim()
			: null;
	const dateFromDedup =
		dedupKey && dedupKey.startsWith("kpi_email_daily:")
			? dedupKey.slice("kpi_email_daily:".length)
			: null;
	const dateKey =
		typeof rawFlow.date_key === "string" && rawFlow.date_key.trim().length > 0
			? rawFlow.date_key.trim()
			: typeof meta.date_key === "string" && meta.date_key.trim().length > 0
				? meta.date_key.trim()
				: dateFromDedup || computeUtcDateKey();

	const generatedAt =
		typeof rawFlow.generated_at === "string" &&
		rawFlow.generated_at.trim().length > 0
			? rawFlow.generated_at
			: typeof row.updated_at === "string"
				? row.updated_at
				: typeof row.created_at === "string"
					? row.created_at
					: new Date().toISOString();

	const toInput = (
		obj: Record<string, unknown>,
	): Omit<ComputeDailyInboxFlowInput, "account"> => ({
		...(typeof obj.starting === "number" ? { starting: obj.starting } : {}),
		...(typeof obj.new_today === "number" ? { new_today: obj.new_today } : {}),
		...(typeof obj.processed_today === "number"
			? { processed_today: obj.processed_today }
			: {}),
		...(typeof obj.end === "number" ? { end: obj.end } : {}),
		...(typeof obj.swept_today === "number"
			? { swept_today: obj.swept_today }
			: {}),
		...(typeof obj.manual_or_reconciled_today === "number"
			? { manual_or_reconciled_today: obj.manual_or_reconciled_today }
			: {}),
	});

	return buildDailyEmailFlowSnapshot({
		date_key: dateKey,
		generated_at: generatedAt,
		personal: toInput(rawPersonal),
		work: toInput(rawWork),
	});
}

/**
 * Alias for `parseStoredDailyEmailFlowArtifact` for callers that parse stored
 * `daily_email_flow_scorecard` artifact rows into a `DailyEmailFlowSnapshot`.
 */
export const parseStoredDailyEmailFlowSnapshot =
	parseStoredDailyEmailFlowArtifact;

/**
 * @ahkms/core/actions/google - gmail_priority_triage (ADR-118; first cut ADR-100, #1990, #2013)
 *
 * The email pipeline, one run:
 *  1. list candidate inbox threads per account, skipping threads an earlier run decided
 *  2. System 1: deterministic signals (headers, labels, graph match) and the rubric's rules pass
 *  3. System 2, only where `selectThinkingMode` escalates: a model reads the thread with
 *     the sender's graph profile, related entities, open tasks and a State Doc excerpt,
 *     returns a rubric judgement, an optional reply draft, and extracted tasks and entities
 *  4. route, then the HITL gate, then the daily attention budget
 *  5. act within the run's mode: shadow (log only), label (log + ahOS/* labels) or
 *     act (labels, archive what the gate cleared, drafts, confident tasks)
 *  6. log every decision (Tier 2), promote what reaches the owner (Tier 3), and report metrics
 *
 * Nothing is ever sent or deleted. Gmail's own tabs feed step 2 as a weak prior only.
 */

import { z } from "zod";
import {
	buildDailyEmailFlowSnapshot,
	clampEmailPriority,
	classifyEmailTriageTier,
	computeUtcDateKey,
	type DailyEmailFlowSnapshot,
	DEFAULT_PRIORITY_CUT_LINE,
	EMAIL_INTENT_CATEGORIES,
	evaluateEmailPriority,
	type EmailIntentCategory,
	type GmailTriageGraphContext,
	MAX_EMAIL_PRIORITY,
	MIN_EMAIL_PRIORITY,
} from "../../domain/emailTriage.js";
import {
	extractEmailSignals,
	type EmailEnvelopeInput,
	type EmailSignalOptions,
	type EmailSignals,
} from "../../domain/emailSignals.js";
import { assessEmailSystem1, EMAIL_RUBRIC_VERSION, type System1Assessment } from "../../domain/emailRubric.js";
import {
	applyAttentionBudget,
	applyHitlPolicy,
	buildEmailDailyDigest,
	DEFAULT_EMAIL_HITL_POLICY,
	EMAIL_PROCESSED_LABEL,
	EMAIL_ROUTE_LABELS,
	INBOX_ROUTES,
	routeEmail,
	selectThinkingMode,
	type EmailAssessment,
	type EmailDailyDigest,
	type EmailHitlPolicy,
	type EmailRoute,
	type HitlOutcome,
	type ThinkingMode,
} from "../../domain/emailRouting.js";
import {
	computeEmailPipelineMetrics,
	type EmailPipelineMetrics,
	type MailboxCounts,
} from "../../domain/emailMetrics.js";
import { localDateKey, type EmailMailboxSnapshot } from "../../domain/emailMetricsSeries.js";
import {
	buildHop1FanOutQuestions,
	buildHop2ResolutionQuestions,
	buildWorthAnalysisQuestion,
	decideFastPath,
	decideHop1FanOut,
	decideHop2Resolution,
	type EmailContextProbeKind,
	type EmailHop1Verdict,
	type EmailHop2ProbeEvidence,
	type EmailHop2Verdict,
} from "../../domain/emailFastPath.js";
import {
	EMAIL_JUDGE_SWEEP_MIN_CONFIDENCE,
	evaluateDecisionBatch,
	probabilityOfYes,
	type DecisionJudgePort,
	type DecisionJudgeQuestion,
	type DecisionJudgeResult,
} from "../../ports/decisionJudge.js";
import type {
	EmailReasonerAssessment,
	EmailReasonerContext,
	EmailReasonerPort,
	ExtractedEmailTask,
} from "../../ports/emailReasoner.js";
import type {
	GmailAccountDomain,
	GmailTriageDecisionRecord,
} from "../../ports/gmailReconcile.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const GMAIL_TRIAGE_ACCOUNT_FILTER = [
	"personal",
	"work",
	"all",
] as const;

export type GmailTriageAccountFilter =
	(typeof GMAIL_TRIAGE_ACCOUNT_FILTER)[number];

export const DEFAULT_TRIAGE_MAX_THREADS = 25;

export const GMAIL_TRIAGE_MODES = ["shadow", "label", "act"] as const;
export type GmailTriageMode = (typeof GMAIL_TRIAGE_MODES)[number];

/** Fallback owner addresses when the port cannot read `identity.emails`. */
export const DEFAULT_OWNER_ADDRESSES = Object.freeze([
	"owner@example.com",
	"owner@work.example.com",
	"owner@work.example.com",
	"owner@work.example.com",
]);

export const gmailPriorityTriageInputSchema = z.object({
	domain: z
		.enum(["work", "angus"])
		.optional()
		.describe(
			"Which domain to act in: 'work' (the Work company mailbox) or 'angus' (the personal mailbox). When omitted, falls back to `account` or 'all'.",
		),
	account: z
		.enum(GMAIL_TRIAGE_ACCOUNT_FILTER)
		.optional()
		.default("all")
		.describe(
			"Gmail account domain to triage ('personal', 'work', or 'all'). Defaults to 'all'.",
		),
	mode: z
		.enum(GMAIL_TRIAGE_MODES)
		.optional()
		.default("shadow")
		.describe(
			"What the run may do to Gmail. 'shadow' (default): judge and log only, Gmail untouched. 'label': also apply ahOS/* labels (reversible). 'act': also archive what the HITL gate cleared, create reply drafts (never sent) and create confident tasks.",
		),
	cut_line_priority: z
		.number()
		.int()
		.min(MIN_EMAIL_PRIORITY)
		.max(MAX_EMAIL_PRIORITY)
		.optional()
		.default(DEFAULT_PRIORITY_CUT_LINE)
		.describe(
			"Priority (1..7) at or above which a thread is routed to the owner and promoted to a Tier-3 artifact. Defaults to 5.",
		),
	attention_budget: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(DEFAULT_EMAIL_HITL_POLICY.dailyAttentionBudget)
		.describe("Daily target for threads that reach the owner (attention, drafts and review). Defaults to 15."),
	use_system_2: z
		.boolean()
		.optional()
		.default(true)
		.describe("Escalate uncertain and human mail to the System 2 model when one is wired. Defaults to true."),
	reprocess: z
		.boolean()
		.optional()
		.default(false)
		.describe("Re-judge threads an earlier run already decided. Defaults to false."),
	dry_run: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"When true, computes everything and writes nothing at all: no decision log, no artifacts, no Gmail changes.",
		),
	max_threads: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(DEFAULT_TRIAGE_MAX_THREADS)
		.describe(
			"Maximum number of inbox threads to evaluate per account. Defaults to 25.",
		),
	include_decisions: z
		.boolean()
		.optional()
		.default(true)
		.describe("Return the full decision list. Set false for a metrics-only reply."),
});

export type GmailPriorityTriageInput = z.infer<
	typeof gmailPriorityTriageInputSchema
>;

export interface GmailTriageThreadCandidate {
	thread_id: string;
	message_id?: string;
	account: GmailAccountDomain;
	sender: string;
	subject: string;
	to?: string | null;
	cc?: string | null;
	snippet?: string | null;
	body?: string | null;
	received_at?: string | null;
	source_url?: string | null;
	/** Gmail label ids on the latest message (CATEGORY_*, IMPORTANT, UNREAD, SENT...). */
	label_ids?: string[];
	list_unsubscribe?: string | null;
	list_id?: string | null;
	precedence?: string | null;
	auto_submitted?: string | null;
	/** Explicit overrides, for callers that already know (tests, attended corrections). */
	intent_category?: EmailIntentCategory;
	base_priority?: number;
	confidence?: number;
	is_direct_recipient?: boolean;
	has_urgency_cue?: boolean;
	is_automated_sender?: boolean;
	is_noise?: boolean;
	graph_context?: GmailTriageGraphContext;
	/** The owner has written to this sender before; skips the sent-mail lookup when set. */
	owner_has_written?: boolean | null;
	linked_entity_ids?: string[];
	existing_artifact_id?: string | null;
}

export interface GmailPriorityTriageSweepTarget {
	account: GmailAccountDomain;
	thread_id: string;
	message_id: string;
}

export interface GmailPriorityTriagePort {
	/** Fetch candidate inbox threads for one account, newest first. */
	listInboxThreads(
		account: GmailAccountDomain,
		maxThreads: number,
		userId?: string,
	): Promise<GmailTriageThreadCandidate[]>;

	/** Enrich a thread with knowledge graph context (sender match, related entities). */
	resolveGraphContext?(
		candidate: GmailTriageThreadCandidate,
		userId?: string,
	): Promise<GmailTriageGraphContext | undefined>;

	/** Persist Tier-2 decision records into `public.system_decisions`. */
	recordTriageDecisions(
		decisions: GmailTriageDecisionRecord[],
		userId?: string,
	): Promise<GmailTriageDecisionRecord[]>;

	/** Promote a thread that reaches the owner to a Tier-3 KMS artifact. */
	promoteThreadToArtifact(
		candidate: GmailTriageThreadCandidate,
		decision: GmailTriageDecisionRecord,
		userId?: string,
	): Promise<{ artifact_id: string } | string | null>;

	/** Archive (remove INBOX) a thread the HITL gate cleared. Act mode only. */
	sweepThread?(
		target: GmailPriorityTriageSweepTarget,
		userId?: string,
	): Promise<void>;

	/**
	 * Optional hook to compute or retrieve daily unread & processed email flow metrics
	 * (`Starting`, `New Today`, `Processed`, `End`) per inbox (`personal`, `work`)
	 * and combined (`all`).
	 */
	getDailyEmailFlow?(
		context: {
			accountFilter: GmailTriageAccountFilter;
			dryRun: boolean;
			evaluatedByAccount: Record<GmailAccountDomain, number>;
			curatedByAccount: Record<GmailAccountDomain, number>;
			sweptByAccount: Record<GmailAccountDomain, number>;
			newTodayByAccount: Record<GmailAccountDomain, number>;
		},
		userId?: string,
	): Promise<DailyEmailFlowSnapshot | undefined>;

	// ---- ADR-118 additions, all optional ----

	/** Every address the owner sends and receives as. */
	getOwnerAddresses?(userId?: string): Promise<string[]>;
	/**
	 * Has the owner ever sent mail to this address, from any mailbox? `null` when the
	 * lookup could not answer. Only asked for strangers whose mail reads like a sales
	 * pitch, so it costs a handful of Gmail calls a run.
	 */
	hasOwnerWrittenTo?(address: string, userId?: string): Promise<boolean | null>;
	/** The System 2 model. Absent: escalations fall back to System 1 and the HITL gate holds them. */
	reasoner?: EmailReasonerPort;
	/** Graph profile, related entities, open tasks and a State Doc excerpt for System 2. */
	loadReasonerContext?(
		candidate: GmailTriageThreadCandidate,
		graph: GmailTriageGraphContext | undefined,
		userId?: string,
	): Promise<EmailReasonerContext>;
	/** Thread ids some earlier run already decided (the processing watermark). */
	listDecidedThreadIds?(threadIds: string[], userId?: string): Promise<Set<string>>;
	/** Threads already routed to the owner since `sinceIso` (for the daily budget). */
	countSurfacedSince?(sinceIso: string, userId?: string): Promise<number>;
	/** Inbox and unread thread counts, for the metrics. */
	countMailbox?(account: GmailAccountDomain): Promise<MailboxCounts>;
	/** Add and remove labels by NAME (the port resolves or creates ids). Label and act modes. */
	applyLabels?(
		target: GmailPriorityTriageSweepTarget,
		labels: { add: string[]; remove: string[] },
	): Promise<void>;
	/** Save a reply draft in the thread. Never sends. Act mode only. */
	createReplyDraft?(
		candidate: GmailTriageThreadCandidate,
		body: string,
	): Promise<{ draft_id: string } | null>;
	/**
	 * Keep the day's mailbox snapshot (inbox and unread per account) up to date: one
	 * metrics artifact per local day, overwritten by each run (ADR-110 §1.4). Every
	 * mode except dry_run, because Gmail keeps no history of these counts.
	 */
	recordMailboxSnapshot?(snapshot: EmailMailboxSnapshot, userId?: string): Promise<void>;
	/** Create tasks the thread asks of the owner; returns how many were created. Act mode only. */
	createTasks?(
		candidate: GmailTriageThreadCandidate,
		tasks: ExtractedEmailTask[],
		artifactId: string | null,
		userId?: string,
	): Promise<number>;
	/**
	 * Calibrated binary/multi-choice probability judge (TypeSafe AI Jev with Gemini fallback).
	 * When provided, runs Stage 1 (`worth_analysis`), Stage 2 Hop 1 (8-question fan-out +
	 * context router), and Stage 2 Hop 2 (3-question context resolution).
	 */
	decisionJudge?: DecisionJudgePort;
	/** Fetch only the internal context slices requested by Stage 2 Hop 1's context router. */
	fetchProbeEvidence?(
		candidate: GmailTriageThreadCandidate,
		probes: readonly EmailContextProbeKind[],
		graph: GmailTriageGraphContext | undefined,
		userId?: string,
	): Promise<EmailHop2ProbeEvidence>;
	/** Backfill `email` onto an existing `people` row matched by exact display name. Act mode only. */
	backfillContactEmail?(
		contactId: string,
		email: string,
		userId?: string,
	): Promise<void>;
	/** Create a new `people` row for a verified human correspondent (`is_new_contact`). Act mode only. */
	createContact?(
		candidate: GmailTriageThreadCandidate,
		signals: EmailSignals,
		userId?: string,
	): Promise<{ contact_id: string } | null>;
	/**
	 * Persist or update the day's digest artifact (`email_digest_daily:<YYYY-MM-DD>`)
	 * for `digest`-routed threads. Invoked when `!dry_run` and at least one decision
	 * has `route === "digest"`.
	 */
	recordDailyDigest?(
		digest: EmailDailyDigest,
		userId?: string,
	): Promise<{ artifact_id: string } | null>;
	/**
	 * Optional discriminative logprob judge (#2121) for calibrated System 1 scoring
	 * (`intent_category`, `base_priority`, `has_urgency_cue`, `is_noise`).
	 */
	judge?: DecisionJudgePort;
}

export interface GmailPriorityTriageOutput {
	account: GmailTriageAccountFilter;
	mode: GmailTriageMode;
	cut_line_priority: number;
	dry_run: boolean;
	rubric_version: string;
	evaluated_count: number;
	skipped_already_decided: number;
	curated_count: number;
	swept_count: number;
	promoted_artifact_count: number;
	logged_decision_count: number;
	should_sweep_low_priority: boolean;
	digest_artifact_id: string | null;
	metrics: EmailPipelineMetrics;
	/** Threads that reach the owner, best first (attention, drafts, review). */
	curated: GmailTriageDecisionRecord[];
	/** Threads filed away (or that would be, outside act mode). */
	swept: GmailTriageDecisionRecord[];
	decisions: GmailTriageDecisionRecord[];
	daily_flow: DailyEmailFlowSnapshot;
	errors: string[];
}

function startOfUtcDay(now: Date): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function countItems(value: readonly string[] | number | undefined): number {
	if (typeof value === "number") return value;
	return Array.isArray(value) ? value.length : 0;
}

const EMAIL_JUDGE_SYSTEM_PROMPT =
	"You are a discriminative email triage judge. Answer with a single token from the allowed options.";

function formatThreadSummaryForJudge(c: GmailTriageThreadCandidate): string {
	const snippet = (c.body ?? c.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
	return [
		`Account: ${c.account}`,
		`From: ${c.sender}`,
		c.to ? `To: ${c.to}` : "",
		`Subject: ${c.subject}`,
		snippet ? `Excerpt: ${snippet}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function judgeNoulBoolean(result: DecisionJudgeResult): boolean {
	if (typeof result.distribution?.yes === "number" && Number.isFinite(result.distribution.yes)) {
		return probabilityOfYes(result) >= 0.5;
	}
	return result.choice.toLowerCase() === "yes";
}

async function safeJudgeEvaluate(
	judge: DecisionJudgePort,
	question: DecisionJudgeQuestion,
	note: (where: string, err: unknown) => void,
): Promise<DecisionJudgeResult | null> {
	try {
		return await judge.evaluate(question);
	} catch (err) {
		note(`judge:${question.id}`, err);
		return null;
	}
}

async function evaluateCandidateWithDecisionJudge(
	judge: DecisionJudgePort,
	candidate: GmailTriageThreadCandidate,
	note: (where: string, err: unknown) => void,
): Promise<{ used: boolean; candidate: GmailTriageThreadCandidate; reasons: string[] }> {
	const summary = formatThreadSummaryForJudge(candidate);
	const [intentResult, priorityResult, urgencyResult, noiseResult] = await Promise.all([
		candidate.intent_category === undefined
			? safeJudgeEvaluate(
					judge,
					{
						kind: "choice",
						id: "intent_category",
						options: EMAIL_INTENT_CATEGORIES,
						system: EMAIL_JUDGE_SYSTEM_PROMPT,
						prompt: `${summary}\nClassify the email's semantic intent category.`,
					},
					note,
				)
			: Promise.resolve(null),
		candidate.base_priority === undefined
			? safeJudgeEvaluate(
					judge,
					{
						kind: "score",
						id: "base_priority",
						min: MIN_EMAIL_PRIORITY,
						max: MAX_EMAIL_PRIORITY,
						options: ["1", "2", "3", "4", "5", "6", "7"],
						system: EMAIL_JUDGE_SYSTEM_PROMPT,
						prompt: `${summary}\nScore the email's base priority from 1 (trivial) to 7 (critical).`,
					},
					note,
				)
			: Promise.resolve(null),
		candidate.has_urgency_cue === undefined
			? safeJudgeEvaluate(
					judge,
					{
						kind: "noul",
						id: "has_urgency_cue",
						system: EMAIL_JUDGE_SYSTEM_PROMPT,
						prompt: `${summary}\nDoes this email contain an explicit urgency or deadline cue? Answer yes or no.`,
					},
					note,
				)
			: Promise.resolve(null),
		candidate.is_noise === undefined
			? safeJudgeEvaluate(
					judge,
					{
						kind: "noul",
						id: "is_noise",
						system: EMAIL_JUDGE_SYSTEM_PROMPT,
						prompt: `${summary}\nIs this email automated noise, bulk marketing, or an unsubscribed digest? Answer yes or no.`,
					},
					note,
				)
			: Promise.resolve(null),
	]);

	const next: GmailTriageThreadCandidate = { ...candidate };
	const reasons: string[] = [];
	let used = false;

	if (
		intentResult &&
		(EMAIL_INTENT_CATEGORIES as readonly string[]).includes(intentResult.choice)
	) {
		next.intent_category = intentResult.choice as EmailIntentCategory;
		reasons.push(`judge_intent:${intentResult.choice}`);
		used = true;
	}

	if (priorityResult) {
		const rawScore =
			typeof priorityResult.score === "number" && Number.isFinite(priorityResult.score)
				? priorityResult.score
				: Number(priorityResult.choice);
		if (Number.isFinite(rawScore)) {
			next.base_priority = clampEmailPriority(rawScore);
			reasons.push(`judge_base_priority:${next.base_priority}`);
			used = true;
		}
	}

	if (urgencyResult) {
		next.has_urgency_cue = judgeNoulBoolean(urgencyResult);
		used = true;
	}

	if (noiseResult) {
		next.is_noise = judgeNoulBoolean(noiseResult);
		used = true;
	}

	if (next.confidence === undefined) {
		const primaryConfidences = [intentResult?.confidence, priorityResult?.confidence].filter(
			(c): c is number => typeof c === "number" && Number.isFinite(c),
		);
		const allConfidences = [
			intentResult?.confidence,
			priorityResult?.confidence,
			urgencyResult?.confidence,
			noiseResult?.confidence,
		].filter((c): c is number => typeof c === "number" && Number.isFinite(c));
		if (primaryConfidences.length > 0) {
			const minPrimary = Math.min(...primaryConfidences);
			next.confidence =
				minPrimary < EMAIL_JUDGE_SWEEP_MIN_CONFIDENCE
					? minPrimary
					: Math.round((primaryConfidences.reduce((a, b) => a + b, 0) / primaryConfidences.length) * 100) / 100;
		} else if (allConfidences.length > 0) {
			next.confidence = Math.min(...allConfidences);
		}
	}

	return { used, candidate: next, reasons };
}

/** Fold a caller's explicit flags into the computed signals (tests and attended corrections). */
function applyCandidateOverrides(signals: EmailSignals, c: GmailTriageThreadCandidate): EmailSignals {
	const out: EmailSignals = { ...signals, cues: { ...signals.cues } };
	if (typeof c.is_direct_recipient === "boolean") out.isDirectRecipient = c.is_direct_recipient;
	if (c.has_urgency_cue === true) out.cues.urgency = true;
	if (c.is_noise === true && out.senderKind !== "known_contact" && out.senderKind !== "self") {
		out.senderKind = "bulk";
		out.hasBulkHeaders = true;
	} else if (c.is_automated_sender === true && (out.senderKind === "human")) {
		out.senderKind = "automated";
	}
	return out;
}

function applySystem1Overrides(s1: System1Assessment, c: GmailTriageThreadCandidate): System1Assessment {
	const out = { ...s1, reasons: [...s1.reasons] };
	if (c.intent_category) {
		out.category = c.intent_category;
		out.reasons.push(`explicit_intent:${c.intent_category}`);
	}
	if (typeof c.base_priority === "number" && Number.isFinite(c.base_priority)) {
		out.priority = Math.min(7, Math.max(1, Math.round(c.base_priority)));
		out.reasons.push(`explicit_priority:${out.priority}`);
	}
	if (typeof c.confidence === "number" && Number.isFinite(c.confidence)) {
		out.confidence = Math.min(1, Math.max(0, c.confidence));
	}
	return out;
}

interface JudgedThread {
	candidate: GmailTriageThreadCandidate;
	signals: EmailSignals;
	assessment: EmailAssessment;
	system2: EmailReasonerAssessment | null;
	hop1?: EmailHop1Verdict | null;
	hop2?: EmailHop2Verdict | null;
	hitl: HitlOutcome;
	linkedEntityIds: string[];
	priority: number;
	route: EmailRoute;
	received_at: string | null;
	over_budget?: boolean;
}

export function createGmailPriorityTriageAction(
	port: GmailPriorityTriagePort,
	options: { policy?: Partial<EmailHitlPolicy>; now?: () => Date } = {},
): ActionDefinition<
	typeof gmailPriorityTriageInputSchema,
	GmailPriorityTriageOutput
> {
	return defineAction({
		id: "gmail_priority_triage",
		domain: "integrations",
		description:
			"Run the email pipeline over both Gmail accounts: rules on every thread, a model with graph and State Doc context on uncertain or human mail, then route, hold risky mail for the owner, and cap theirs at 15 a day. mode 'shadow' (default) only logs; 'label' adds ahOS/* labels; 'act' also archives, drafts and files tasks. Notes: docs/guides/tools/gmail_priority_triage.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: gmailPriorityTriageInputSchema,
		run: async (input, ctx) => {
			const now = options.now?.() ?? new Date();
			const userId = ctx?.userId;
			const domainAccount: GmailTriageAccountFilter | undefined =
				input.domain === "angus" ? "personal" : input.domain === "work" ? "work" : undefined;
			const accountFilter: GmailTriageAccountFilter =
				input.account && input.account !== "all" ? input.account : (domainAccount ?? input.account ?? "all");
			const cutLine = input.cut_line_priority ?? DEFAULT_PRIORITY_CUT_LINE;
			const dryRun = input.dry_run ?? false;
			const mode: GmailTriageMode = input.mode ?? "shadow";
			const maxThreads = input.max_threads ?? DEFAULT_TRIAGE_MAX_THREADS;
			const policy: EmailHitlPolicy = {
				...DEFAULT_EMAIL_HITL_POLICY,
				...options.policy,
				attentionCutLine: cutLine,
				dailyAttentionBudget: input.attention_budget ?? DEFAULT_EMAIL_HITL_POLICY.dailyAttentionBudget,
			};
			const useSystem2 = (input.use_system_2 ?? true) && Boolean(port.reasoner);
			const canLabel = !dryRun && (mode === "label" || mode === "act") && Boolean(port.applyLabels);
			const canAct = !dryRun && mode === "act";
			const errors: string[] = [];
			const note = (where: string, err: unknown) =>
				errors.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);

			const targetAccounts: GmailAccountDomain[] =
				accountFilter === "all" ? ["personal", "work"] : [accountFilter];

			let ownerAddresses: string[] = [...DEFAULT_OWNER_ADDRESSES];
			if (port.getOwnerAddresses) {
				try {
					const fromPort = await port.getOwnerAddresses(userId);
					ownerAddresses = Array.from(new Set([...ownerAddresses, ...fromPort.map((a) => a.toLowerCase())]));
				} catch (err) {
					note("owner_addresses", err);
				}
			}

			// 1. Candidates and mailbox counts.
			const mailboxBefore: Record<string, MailboxCounts> = {};
			const candidates: GmailTriageThreadCandidate[] = [];
			for (const account of targetAccounts) {
				if (port.countMailbox) {
					try {
						mailboxBefore[account] = await port.countMailbox(account);
					} catch (err) {
						note(`count_mailbox:${account}`, err);
					}
				}
				candidates.push(...(await port.listInboxThreads(account, maxThreads, userId)));
			}

			let decided = new Set<string>();
			if (!(input.reprocess ?? false) && port.listDecidedThreadIds && candidates.length > 0) {
				try {
					decided = await port.listDecidedThreadIds(candidates.map((c) => c.thread_id), userId);
				} catch (err) {
					note("decided_threads", err);
				}
			}
			const fresh = candidates.filter((c) => !decided.has(c.thread_id));

			// 2-4. Judge every fresh thread.
			let system2Calls = 0;
			const judged: JudgedThread[] = [];
			for (const candidate of fresh) {
				let graph = candidate.graph_context;
				if (port.resolveGraphContext) {
					try {
						const resolved = await port.resolveGraphContext(candidate, userId);
						graph = resolved || graph ? { ...graph, ...resolved } : undefined;
					} catch (err) {
						note(`graph:${candidate.thread_id}`, err);
					}
				}
				const knownContact = Boolean(graph?.isKeyPerson) || countItems(graph?.keyPeople) > 0;

				const judgeEval = port.judge
					? await evaluateCandidateWithDecisionJudge(port.judge, candidate, note)
					: { used: false, candidate, reasons: [] as string[] };
				const effectiveCandidate = judgeEval.candidate;

				const envelope: EmailEnvelopeInput = {
					from: candidate.sender,
					to: candidate.to,
					cc: candidate.cc,
					subject: candidate.subject,
					snippet: candidate.snippet,
					body: candidate.body,
					labelIds: candidate.label_ids,
					listUnsubscribe: candidate.list_unsubscribe,
					listId: candidate.list_id,
					precedence: candidate.precedence,
					autoSubmitted: candidate.auto_submitted,
				};
				const signalOptions: EmailSignalOptions = {
					ownerAddresses,
					knownContact,
					contactId: graph?.contactId ?? null,
					contactMissingEmail: graph?.contactMissingEmail ?? false,
					relationship: graph?.relationship ?? null,
					ownerHasWritten: candidate.owner_has_written ?? null,
				};
				let signals = applyCandidateOverrides(extractEmailSignals(envelope, signalOptions), effectiveCandidate);
				// Cold outreach needs proof the owner never wrote to the sender: ask Sent mail,
				// either when the mail reads like a pitch (System 1) or when the calibrated
				// `decisionJudge` is evaluating a human sender.
				if (
					signals.senderKind === "human" &&
					(signals.cues.salesPitch || Boolean(port.decisionJudge)) &&
					signals.ownerHasWritten === null &&
					port.hasOwnerWrittenTo
				) {
					try {
						const written = await port.hasOwnerWrittenTo(signals.senderAddress, userId);
						if (typeof written === "boolean") {
							signals = applyCandidateOverrides(
								extractEmailSignals(envelope, { ...signalOptions, ownerHasWritten: written }),
								effectiveCandidate,
							);
						}
					} catch (err) {
						note(`sent_history:${candidate.thread_id}`, err);
					}
				}
				const system1 = applySystem1Overrides(assessEmailSystem1(signals), effectiveCandidate);
				if (judgeEval.used) {
					const priorityEval = evaluateEmailPriority({
						intentCategory: effectiveCandidate.intent_category ?? system1.category,
						basePriority: effectiveCandidate.base_priority,
						isDirectRecipient: candidate.is_direct_recipient,
						hasUrgencyCue: effectiveCandidate.has_urgency_cue,
						isAutomatedSender: candidate.is_automated_sender ?? false,
						isNoise: effectiveCandidate.is_noise,
						subject: candidate.subject,
						snippet: candidate.snippet ?? undefined,
						sender: candidate.sender,
						graphContext: graph,
					});
					system1.priority = priorityEval.priority;
					for (const r of [...judgeEval.reasons, ...priorityEval.reasons]) {
						if (!system1.reasons.includes(r)) system1.reasons.push(r);
					}
				}
				const selection = selectThinkingMode(signals, system1, policy);

				let assessment: EmailAssessment = {
					category: system1.category,
					priority: system1.priority,
					confidence: system1.confidence,
					thinkingMode: "system_1",
					reasons: [...system1.reasons, `thinking:${selection.reasons.join("+")}`],
				};
				let system2: EmailReasonerAssessment | null = null;
				let hop1: EmailHop1Verdict | null = null;
				let hop2: EmailHop2Verdict | null = null;

				if (port.decisionJudge && (input.use_system_2 ?? true)) {
					const fpInput = {
						from: candidate.sender,
						to: candidate.to,
						cc: candidate.cc,
						subject: candidate.subject,
						text: candidate.body ?? candidate.snippet,
						signals,
					};
					const s1Result = await port.decisionJudge.evaluate(buildWorthAnalysisQuestion(fpInput));
					const fastVerdict = decideFastPath(s1Result);

					if (!fastVerdict.analyse) {
						if (signals.senderKind === "human" && signals.ownerHasWritten === false) {
							signals = { ...signals, isColdOutreach: true };
						}
						assessment = {
							category: "marketing",
							priority: 1,
							confidence: Math.max(s1Result?.confidence ?? 0.92, policy.autoApplyConfidence),
							thinkingMode: "system_1",
							reasons: [
								...system1.reasons,
								`fast_path:${fastVerdict.reason}`,
								`fast_path_p_yes:${fastVerdict.pYes !== null ? fastVerdict.pYes.toFixed(3) : "null"}`,
							],
							needsReply: false,
							suggestedRoute: "archive",
						};
					} else {
						system2Calls += 1;
						const h1Results = await evaluateDecisionBatch(
							port.decisionJudge,
							buildHop1FanOutQuestions(fpInput),
						);
						hop1 = decideHop1FanOut(h1Results, signals);
						const judgeReasons = [
							...system1.reasons,
							`fast_path:${fastVerdict.reason}`,
							`hop1:reply=${hop1.needs_reply}`,
							`hop1:commit=${hop1.has_owner_commitment}`,
							`hop1:fact=${hop1.has_fact_to_persist}`,
							`hop1:new_contact=${hop1.is_new_contact}`,
							`hop1:backfill_email=${hop1.needs_contact_email_backfill}`,
							`hop1:probes=${hop1.probes.join("+") || "none"}`,
						];

						if (hop1.needs_hop2) {
							let probeEvidence: EmailHop2ProbeEvidence = {};
							if (port.fetchProbeEvidence) {
								try {
									probeEvidence = await port.fetchProbeEvidence(candidate, hop1.probes, graph, userId);
								} catch (err) {
									note(`probes:${candidate.thread_id}`, err);
								}
							}
							const h2Results = await evaluateDecisionBatch(
								port.decisionJudge,
								buildHop2ResolutionQuestions(fpInput, probeEvidence),
							);
							hop2 = decideHop2Resolution(hop1, h2Results);
							judgeReasons.push(
								`hop2:satisfied=${hop2.commitment_already_satisfied}`,
								`hop2:adds_info=${hop2.adds_info_to_existing_item}`,
								`hop2:escalate=${hop2.needs_owner_escalation}`,
							);
						}

						const needsEscalation = hop2
							? hop2.needs_owner_escalation
							: hop1.needs_reply || hop1.has_owner_commitment;

						if (!needsEscalation) {
							assessment = {
								category: hop1.has_fact_to_persist ? "notification" : "fyi",
								priority: hop1.has_fact_to_persist ? 3 : 2,
								confidence: Math.max(policy.autoApplyConfidence, 0.92),
								thinkingMode: "system_2",
								reasons: judgeReasons,
								needsReply: false,
								suggestedRoute: "archive",
							};
						} else {
							assessment = {
								category: hop1.needs_reply
									? "to_respond"
									: system1.category === "marketing"
										? "to_respond"
										: system1.category,
								priority: Math.max(system1.priority, cutLine),
								confidence: Math.max(policy.autoApplyConfidence, 0.92),
								thinkingMode: "system_2",
								reasons: judgeReasons,
								needsReply: hop1.needs_reply,
								suggestedRoute: "attention",
							};

							// Optionally invoke the generative reasoner on escalated threads to draft a reply or extract structured tasks.
							if (useSystem2 && port.reasoner && system2Calls <= policy.maxSystem2Calls) {
								let context: EmailReasonerContext = {};
								if (port.loadReasonerContext) {
									try {
										context = await port.loadReasonerContext(candidate, graph, userId);
									} catch (err) {
										note(`context:${candidate.thread_id}`, err);
									}
								}
								const mayReply =
									signals.senderKind === "known_contact" || signals.senderKind === "human";
								system2 = await port.reasoner.assess({
									account: candidate.account,
									thread_id: candidate.thread_id,
									sender: candidate.sender,
									subject: candidate.subject,
									snippet: candidate.snippet,
									body: candidate.body,
									received_at: candidate.received_at,
									signals,
									system1,
									context,
									want_draft: mayReply && hop1.needs_reply,
									want_extraction: true,
								});
								if (system2) {
									assessment.hasDraft = Boolean(system2.draft_reply);
									if (system2.draft_reply && hop1.needs_reply) {
										assessment.suggestedRoute = "draft_reply";
									}
								}
							}
						}
					}
				} else if (selection.mode === "system_2") {
					if (useSystem2 && system2Calls < policy.maxSystem2Calls && port.reasoner) {
						system2Calls += 1;
						let context: EmailReasonerContext = {};
						if (port.loadReasonerContext) {
							try {
								context = await port.loadReasonerContext(candidate, graph, userId);
							} catch (err) {
								note(`context:${candidate.thread_id}`, err);
							}
						}
						const mayReply =
							signals.senderKind === "known_contact" || signals.senderKind === "human";
						system2 = await port.reasoner.assess({
							account: candidate.account,
							thread_id: candidate.thread_id,
							sender: candidate.sender,
							subject: candidate.subject,
							snippet: candidate.snippet,
							body: candidate.body,
							received_at: candidate.received_at,
							signals,
							system1,
							context,
							want_draft: mayReply && system1.priority >= policy.draftReplyMinPriority - 1,
							want_extraction: mayReply || system1.priority >= cutLine - 1,
						});
					}
					if (system2) {
						assessment = {
							category: system2.category,
							priority: system2.priority,
							confidence: system2.confidence,
							thinkingMode: "system_2",
							reasons: [...assessment.reasons, `system_2:${system2.rationale}`],
							needsReply: system2.needs_reply,
							hasDraft: Boolean(system2.draft_reply),
							suggestedRoute: system2.suggested_route ?? null,
						};
					} else {
						// Escalation was wanted and is unavailable: never let the rules alone
						// auto-apply on mail they were unsure about.
						if (!judgeEval.used || useSystem2) {
							assessment.confidence = Math.min(assessment.confidence, policy.autoApplyConfidence - 0.01);
						}
						assessment.reasons.push(useSystem2 ? "system_2_failed" : "system_2_unavailable");
					}
				}

				const naturalRoute = routeEmail(assessment, signals, policy);
				let hitl = applyHitlPolicy(naturalRoute, assessment, signals, policy);
				const tierClassification = classifyEmailTriageTier(assessment.priority, cutLine, {
					confidence: assessment.confidence,
					hasHighPriorityItems: true,
				});
				if (
					judgeEval.used &&
					tierClassification.confidence < EMAIL_JUDGE_SWEEP_MIN_CONFIDENCE &&
					!hitl.keepInInbox
				) {
					hitl = {
						...hitl,
						route: "review",
						requiresHuman: true,
						autoApply: false,
						keepInInbox: true,
						hitlReasons: [...hitl.hitlReasons, "low_judge_confidence"],
					};
					assessment.reasons.push("judge_confidence_below_sweep_floor");
				}
				const linked = new Set<string>(candidate.linked_entity_ids ?? []);
				if (Array.isArray(graph?.matchedHotEntities)) {
					for (const id of graph.matchedHotEntities) if (typeof id === "string" && id) linked.add(id);
				}

				judged.push({
					candidate,
					signals,
					assessment,
					system2,
					hop1,
					hop2,
					hitl,
					linkedEntityIds: Array.from(linked),
					priority: assessment.priority,
					route: hitl.route,
					received_at: candidate.received_at ?? null,
				});
			}

			// Daily budget across runs.
			let surfacedToday = 0;
			if (port.countSurfacedSince) {
				try {
					surfacedToday = await port.countSurfacedSince(startOfUtcDay(now), userId);
				} catch (err) {
					note("surfaced_today", err);
				}
			}
			const budget = applyAttentionBudget(judged, policy.dailyAttentionBudget, surfacedToday);
			for (const j of budget.overflow) {
				j.over_budget = true;
				j.assessment.reasons.push("over_daily_budget");
			}
			const owedOrder = new Map(budget.attention.concat(budget.overflow).map((j, i) => [j, i]));

			// 5-6. Act within the mode, promote, log.
			let promotedArtifactCount = 0;
			const decisionFor = new Map<JudgedThread, GmailTriageDecisionRecord>();

			for (const j of judged) {
				const { candidate, hitl, assessment, signals, system2 } = j;
				const messageId = candidate.message_id ?? candidate.thread_id;
				const target: GmailPriorityTriageSweepTarget = {
					account: candidate.account,
					thread_id: candidate.thread_id,
					message_id: messageId,
				};
				const thinkingMode: ThinkingMode = assessment.thinkingMode;
				const reachesOwner = INBOX_ROUTES.has(j.route);
				const persistFact = Boolean(j.hop1?.has_fact_to_persist);
				const tierClassification = classifyEmailTriageTier(assessment.priority, cutLine, {
					confidence: assessment.confidence,
					hasHighPriorityItems: budget.attention.length > 0 || budget.overflow.length > 0,
				});
				const decision: GmailTriageDecisionRecord = {
					thread_id: candidate.thread_id,
					message_id: messageId,
					account: candidate.account,
					sender: candidate.sender,
					subject: candidate.subject,
					snippet: candidate.snippet ?? null,
					intent_category: assessment.category,
					priority: assessment.priority,
					confidence: tierClassification.confidence,
					storage_tier:
						reachesOwner || assessment.priority >= cutLine || persistFact
							? "tier_3_full_artifact"
							: tierClassification.storageTier,
					gmail_action: hitl.keepInInbox ? "keep_inbox" : "sweep_archive",
					artifact_id: candidate.existing_artifact_id ?? null,
					linked_entity_ids: j.linkedEntityIds,
					reasons: assessment.reasons,
					received_at: j.received_at,
					route: j.route,
					natural_route: hitl.naturalRoute,
					thinking_mode: thinkingMode,
					requires_human: hitl.requiresHuman,
					hitl_reasons: hitl.hitlReasons,
					mode: dryRun ? "dry_run" : mode,
					applied: false,
					over_budget: j.over_budget ?? false,
					rubric_version: EMAIL_RUBRIC_VERSION,
					rationale: system2?.rationale ?? null,
					sender_kind: signals.senderKind,
					gmail_category: signals.gmailCategory,
					gmail_category_contradiction: signals.gmailCategoryContradiction,
					draft_id: null,
					draft_reply: system2?.draft_reply ?? null,
					extracted_tasks: system2?.tasks ?? [],
					extracted_entities: system2?.entities ?? [],
					created_task_count: 0,
				};

				if (
					canAct &&
					j.hop1?.needs_contact_email_backfill &&
					signals.contactId &&
					signals.senderAddress &&
					port.backfillContactEmail
				) {
					try {
						await port.backfillContactEmail(signals.contactId, signals.senderAddress, userId);
						decision.reasons = [...(decision.reasons ?? []), "act:backfilled_contact_email"];
					} catch (err) {
						note(`backfill_email:${candidate.thread_id}`, err);
					}
				}

				if (canAct && j.hop1?.is_new_contact && port.createContact) {
					try {
						const created = await port.createContact(candidate, signals, userId);
						if (created?.contact_id) {
							decision.linked_entity_ids = Array.from(
								new Set([...(decision.linked_entity_ids ?? []), created.contact_id]),
							);
							decision.reasons = [...(decision.reasons ?? []), "act:created_contact"];
						}
					} catch (err) {
						note(`create_contact:${candidate.thread_id}`, err);
					}
				}

				if (!dryRun && decision.storage_tier === "tier_3_full_artifact" && !decision.artifact_id) {
					try {
						const promoted = await port.promoteThreadToArtifact(candidate, decision, userId);
						const id = typeof promoted === "string" ? promoted : promoted?.artifact_id;
						if (id) {
							decision.artifact_id = id;
							promotedArtifactCount += 1;
						}
					} catch (err) {
						note(`promote:${candidate.thread_id}`, err);
					}
				}

				if (canLabel && hitl.autoApply && port.applyLabels) {
					try {
						await port.applyLabels(target, { add: [EMAIL_PROCESSED_LABEL, EMAIL_ROUTE_LABELS[j.route]], remove: [] });
						decision.applied = true;
					} catch (err) {
						note(`label:${candidate.thread_id}`, err);
					}
				}

				if (canAct && hitl.autoApply && !hitl.keepInInbox && port.sweepThread) {
					try {
						await port.sweepThread(target, userId);
						decision.applied = true;
					} catch (err) {
						note(`archive:${candidate.thread_id}`, err);
					}
				}

				if (canAct && j.route === "draft_reply" && decision.draft_reply && port.createReplyDraft) {
					try {
						const draft = await port.createReplyDraft(candidate, decision.draft_reply);
						decision.draft_id = draft?.draft_id ?? null;
					} catch (err) {
						note(`draft:${candidate.thread_id}`, err);
					}
				}

				const confidentTasks = (decision.extracted_tasks ?? []).filter(
					(t) => t.confidence >= policy.autoApplyConfidence,
				);
				if (canAct && confidentTasks.length > 0 && port.createTasks) {
					try {
						decision.created_task_count = await port.createTasks(candidate, confidentTasks, decision.artifact_id ?? null, userId);
					} catch (err) {
						note(`tasks:${candidate.thread_id}`, err);
					}
				}

				decisionFor.set(j, decision);
			}

			const curatedJudged = [...budget.attention, ...budget.overflow];
			const curated = curatedJudged
				.sort((a, b) => (owedOrder.get(a) ?? 0) - (owedOrder.get(b) ?? 0))
				.map((j) => decisionFor.get(j) as GmailTriageDecisionRecord);
			const swept = judged
				.filter((j) => !INBOX_ROUTES.has(j.route))
				.sort((a, b) => Date.parse(b.received_at ?? "") - Date.parse(a.received_at ?? "") || 0)
				.map((j) => decisionFor.get(j) as GmailTriageDecisionRecord);
			const allDecisions = [...curated, ...swept];

			let loggedDecisionCount = 0;
			if (!dryRun && allDecisions.length > 0) {
				try {
					loggedDecisionCount = (await port.recordTriageDecisions(allDecisions, userId)).length;
				} catch (err) {
					note("record_decisions", err);
				}
			}

			const metrics = computeEmailPipelineMetrics(
				allDecisions.map((d) => ({
					account: String(d.account),
					route: d.route as EmailRoute,
					intent_category: d.intent_category,
					priority: d.priority,
					thinking_mode: d.thinking_mode as ThinkingMode,
					requires_human: d.requires_human === true,
					applied: d.applied,
					over_budget: d.over_budget,
					draft_created: Boolean(d.draft_id),
					tasks_extracted: d.extracted_tasks?.length ?? 0,
					entities_extracted: d.extracted_entities?.length ?? 0,
					gmail_category_contradiction: d.gmail_category_contradiction,
					is_new: true,
				})),
				{ mailboxBefore, attentionBudget: policy.dailyAttentionBudget },
			);
			if (!dryRun && port.recordMailboxSnapshot && Object.keys(mailboxBefore).length > 0) {
				try {
					await port.recordMailboxSnapshot(
						{ date: localDateKey(now), observed_at: now.toISOString(), accounts: mailboxBefore },
						userId,
					);
				} catch (err) {
					note("mailbox_snapshot", err);
				}
			}

			const digestJudged = judged.filter((j) => j.route === "digest");
			let digestArtifactId: string | null = null;
			if (!dryRun && port.recordDailyDigest && digestJudged.length > 0) {
				try {
					const digest = buildEmailDailyDigest({
						date: localDateKey(now),
						generated_at: now.toISOString(),
						items: digestJudged.map((j) => {
							const dec = decisionFor.get(j);
							return {
								thread_id: j.candidate.thread_id,
								account: j.candidate.account,
								sender: j.candidate.sender,
								subject: j.candidate.subject,
								snippet: j.candidate.snippet ?? null,
								priority: dec?.priority ?? j.priority,
								intent_category: dec?.intent_category ?? j.assessment.category,
								received_at: j.received_at,
								source_url: j.candidate.source_url ?? null,
							};
						}),
					});
					const saved = await port.recordDailyDigest(digest, userId);
					digestArtifactId = saved?.artifact_id ?? null;
				} catch (err) {
					note("daily_digest", err);
				}
			}

			const evaluatedByAccount: Record<GmailAccountDomain, number> = {
				personal: 0,
				work: 0,
			};
			const curatedByAccount: Record<GmailAccountDomain, number> = {
				personal: 0,
				work: 0,
			};
			const sweptByAccount: Record<GmailAccountDomain, number> = {
				personal: 0,
				work: 0,
			};
			const newTodayByAccount: Record<GmailAccountDomain, number> = {
				personal: 0,
				work: 0,
			};

			let latestReceivedMs = Number.NEGATIVE_INFINITY;
			let latestReceivedIso: string | undefined;
			for (const decision of allDecisions) {
				if (
					typeof decision.received_at === "string" &&
					decision.received_at.length > 0
				) {
					const parsedMs = Date.parse(decision.received_at);
					if (Number.isFinite(parsedMs) && parsedMs > latestReceivedMs) {
						latestReceivedMs = parsedMs;
						latestReceivedIso = decision.received_at;
					}
				}
			}
			const activeDateKey = computeUtcDateKey(latestReceivedIso ?? now);

			for (const decision of allDecisions) {
				const acc: GmailAccountDomain =
					decision.account === "work" ? "work" : "personal";
				evaluatedByAccount[acc] += 1;
				if (decision.gmail_action === "sweep_archive") {
					sweptByAccount[acc] += 1;
				} else {
					curatedByAccount[acc] += 1;
				}
				if (
					decision.received_at &&
					computeUtcDateKey(decision.received_at) === activeDateKey
				) {
					newTodayByAccount[acc] += 1;
				}
			}

			let resolvedDailyFlow: DailyEmailFlowSnapshot | undefined;
			if (port.getDailyEmailFlow) {
				try {
					resolvedDailyFlow = await port.getDailyEmailFlow(
						{
							accountFilter,
							dryRun,
							evaluatedByAccount,
							curatedByAccount,
							sweptByAccount,
							newTodayByAccount,
						},
						userId,
					);
				} catch (err) {
					note("daily_email_flow", err);
				}
			}

			const dailyFlow: DailyEmailFlowSnapshot =
				resolvedDailyFlow ??
				buildDailyEmailFlowSnapshot({
					date_key: activeDateKey,
					personal: {
						starting: Math.max(
							0,
							evaluatedByAccount.personal - newTodayByAccount.personal,
						),
						new_today: newTodayByAccount.personal,
						processed_today: sweptByAccount.personal,
						swept_today: sweptByAccount.personal,
						end: curatedByAccount.personal,
					},
					work: {
						starting: Math.max(
							0,
							evaluatedByAccount.work - newTodayByAccount.work,
						),
						new_today: newTodayByAccount.work,
						processed_today: sweptByAccount.work,
						swept_today: sweptByAccount.work,
						end: curatedByAccount.work,
					},
				});

			const includeDecisions = input.include_decisions ?? true;

			return {
				account: accountFilter,
				mode,
				cut_line_priority: cutLine,
				dry_run: dryRun,
				rubric_version: EMAIL_RUBRIC_VERSION,
				evaluated_count: allDecisions.length,
				skipped_already_decided: candidates.length - fresh.length,
				curated_count: curated.length,
				swept_count: swept.length,
				promoted_artifact_count: promotedArtifactCount,
				logged_decision_count: loggedDecisionCount,
				should_sweep_low_priority: canAct,
				digest_artifact_id: digestArtifactId,
				metrics,
				curated: includeDecisions ? curated : [],
				swept: includeDecisions ? swept : [],
				decisions: includeDecisions ? allDecisions : [],
				daily_flow: dailyFlow,
				errors,
			};
		},
	});
}

const MEETING_CUE_PATTERN =
	/\b(invitation|updated invitation|canceled event|calendar|meeting|reschedule|zoom\.us|meet\.google\.com)\b/i;
const MARKETING_CUE_PATTERN =
	/\b(unsubscribe|newsletter|weekly digest|special offer|promo|sale|marketing)\b/i;
const COMMENT_CUE_PATTERN =
	/\b(commented on|mentioned you in|left a comment|new comment)\b/i;
const NOTIFICATION_CUE_PATTERN =
	/\b(alert|notification|security alert|receipt for|invoice|build failed|ci\/cd)\b/i;
const RESPOND_CUE_PATTERN =
	/\b(can you|could you|please review|please confirm|thoughts\?|wdyt|action required|urgent|by eod|deadline)\b/i;

/**
 * Legacy single-pass intent guess (#2013). Kept for callers that only have subject and
 * flags; the pipeline itself uses `assessEmailSystem1` (ADR-118).
 * @deprecated Use `extractEmailSignals` + `assessEmailSystem1`.
 */
export function inferEmailIntentCategory(
	candidate: GmailTriageThreadCandidate,
): EmailIntentCategory {
	if (candidate.intent_category) {
		return candidate.intent_category;
	}

	const combined = `${candidate.subject ?? ""} ${candidate.snippet ?? ""} ${candidate.body ?? ""}`.trim();

	if (
		candidate.is_noise === true ||
		MARKETING_CUE_PATTERN.test(combined)
	) {
		return "marketing";
	}

	if (MEETING_CUE_PATTERN.test(combined)) {
		return "meeting_update";
	}

	if (COMMENT_CUE_PATTERN.test(combined)) {
		return "comment";
	}

	if (
		candidate.graph_context?.pendingReply === true
	) {
		return "awaiting_reply";
	}

	if (
		candidate.has_urgency_cue === true ||
		RESPOND_CUE_PATTERN.test(combined) ||
		(candidate.is_direct_recipient === true &&
			candidate.is_automated_sender !== true)
	) {
		return "to_respond";
	}

	if (
		candidate.is_automated_sender === true ||
		NOTIFICATION_CUE_PATTERN.test(combined)
	) {
		return "notification";
	}

	return "fyi";
}

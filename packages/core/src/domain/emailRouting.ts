/**
 * @ahkms/core/domain - emailRouting.ts
 *
 * What happens to an email once it is judged (ADR-118):
 * - which route it takes (attention, draft_reply, digest, archive, review, ...)
 * - which thinking mode each pipeline task runs in (System 1 rules or System 2 model)
 * - when a human must decide (the HITL policy), and
 * - how the daily attention budget is enforced.
 *
 * The router never sends mail and never deletes it. The most it does unattended is
 * label and archive, and Gmail puts an archived thread back in the inbox the moment a
 * new message arrives on it, so every route is reversible.
 *
 * Isomorphic: zero Node imports.
 */

import type { EmailIntentCategory } from "./emailTriage.js";
import type { EmailSignals } from "./emailSignals.js";
import { isKeyRelationship } from "./emailRubric.js";

export const EMAIL_ROUTES = [
	"attention",
	"draft_reply",
	"review",
	"calendar",
	"awaiting_reply",
	"digest",
	"archive",
	"unsubscribe_candidate",
] as const;

export type EmailRoute = (typeof EMAIL_ROUTES)[number];

/** Routes that keep the thread in the inbox: the things the owner is asked to look at. */
export const INBOX_ROUTES: ReadonlySet<EmailRoute> = new Set<EmailRoute>([
	"attention",
	"draft_reply",
	"review",
]);

/** The Gmail label each route applies. Labels are the reversible half of every decision. */
export const EMAIL_ROUTE_LABELS: Readonly<Record<EmailRoute, string>> = Object.freeze({
	attention: "ahOS/Attention",
	draft_reply: "ahOS/Draft",
	review: "ahOS/Review",
	calendar: "ahOS/Calendar",
	awaiting_reply: "ahOS/Awaiting",
	digest: "ahOS/Digest",
	archive: "ahOS/Archived",
	unsubscribe_candidate: "ahOS/Unsubscribe",
});

/** Applied to every thread the pipeline has judged; the processing watermark. */
export const EMAIL_PROCESSED_LABEL = "ahOS/Triaged";

export const THINKING_MODES = ["system_1", "system_2"] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

/**
 * Which thinking mode each task in the pipeline runs in. System 1 is fast, cheap and
 * deterministic; System 2 is slow, costs a model call and reads context. "escalate"
 * means System 1 first, System 2 only when `selectThinkingMode` says so.
 */
export const EMAIL_TASK_THINKING_MODES = Object.freeze({
	signal_extraction: "system_1",
	noise_filter: "system_1",
	categorise: "escalate",
	prioritise: "escalate",
	route: "system_1",
	hitl_gate: "system_1",
	reply_draft: "system_2",
	entity_extraction: "system_2",
	task_extraction: "system_2",
	gmail_label_and_archive: "system_1",
	metrics: "system_1",
} as const satisfies Record<string, ThinkingMode | "escalate">);

export type EmailPipelineTask = keyof typeof EMAIL_TASK_THINKING_MODES;

export interface EmailHitlPolicy {
	/** At or above this confidence a HIGH-STAKES decision is applied without review. */
	autoApplyConfidence: number;
	/** Low-stakes machine mail below this confidence escalates to System 2. */
	system2EscalationConfidence: number;
	/** Below this confidence the pipeline takes no Gmail action at all (stays in inbox, unlabelled). */
	actConfidenceFloor: number;
	/** The daily target: at most this many threads routed to the owner (attention + draft + review). */
	dailyAttentionBudget: number;
	/** Priority at or above which a thread is routed to the owner. */
	attentionCutLine: number;
	/** Never archive mail from a graph-known contact without System 2 at auto-apply confidence. */
	protectKnownContacts: boolean;
	/** Never archive money / security / legal mail on System 1 alone. */
	protectSensitive: boolean;
	/** Draft replies for to_respond threads at or above this priority (System 2 only). */
	draftReplyMinPriority: number;
	/** Most System 2 calls one run may spend. */
	maxSystem2Calls: number;
}

export const DEFAULT_EMAIL_HITL_POLICY: Readonly<EmailHitlPolicy> = Object.freeze({
	autoApplyConfidence: 0.9,
	system2EscalationConfidence: 0.7,
	actConfidenceFloor: 0.55,
	dailyAttentionBudget: 15,
	attentionCutLine: 5,
	protectKnownContacts: true,
	protectSensitive: true,
	draftReplyMinPriority: 5,
	maxSystem2Calls: 40,
});

export interface EmailAssessment {
	category: EmailIntentCategory;
	priority: number;
	confidence: number;
	thinkingMode: ThinkingMode;
	reasons: string[];
	/** System 2 says the owner owes a reply. */
	needsReply?: boolean;
	/** System 2 produced a reply draft. */
	hasDraft?: boolean;
	/** System 2 suggested a route; the policy below still has the last word. */
	suggestedRoute?: EmailRoute | null;
}

/**
 * Stakes decide how sure the pipeline must be. Archiving a mis-judged sock promotion
 * costs nothing; archiving a mis-judged investor email costs a relationship. A thread
 * is high-stakes when a person is involved (cold sales outreach does not count), when it is sensitive, when Gmail and the
 * graph disagree about it, or when it sits near the owner's attention line.
 */
export function isHighStakes(
	signals: EmailSignals,
	assessment: Pick<EmailAssessment, "priority">,
	policy: EmailHitlPolicy = DEFAULT_EMAIL_HITL_POLICY,
): boolean {
	// Calendar bookkeeping (Accepted:, Declined:, Notes:) is low-stakes from anyone:
	// Calendar and the meeting-notes pipeline hold the substance.
	if (signals.cues.meetingResponse || signals.cues.meetingNotes) return false;
	return (
		signals.knownContact ||
		(signals.senderKind === "human" && !signals.isColdOutreach) ||
		(signals.isSensitive && signals.senderKind !== "bulk") ||
		signals.gmailCategoryContradiction ||
		assessment.priority >= policy.attentionCutLine - 1
	);
}

export interface ThinkingModeSelection {
	mode: ThinkingMode;
	reasons: string[];
}

/**
 * Decide whether a thread needs System 2 after the System 1 pass.
 *
 * Escalate when a person is involved, when the rules are unsure, when Gmail and the
 * graph disagree, when the mail is sensitive, or when it might reach the owner. Stay in
 * System 1 for confident machine mail: that is most of the inbox, and it is exactly the
 * mail a model adds nothing to.
 */
export function selectThinkingMode(
	signals: EmailSignals,
	system1: Pick<EmailAssessment, "priority" | "confidence">,
	policy: EmailHitlPolicy = DEFAULT_EMAIL_HITL_POLICY,
): ThinkingModeSelection {
	const reasons: string[] = [];
	if (!isHighStakes(signals, system1, policy)) {
		return system1.confidence < policy.system2EscalationConfidence
			? { mode: "system_2", reasons: ["low_system1_confidence"] }
			: { mode: "system_1", reasons: ["confident_low_stakes"] };
	}
	if (signals.senderKind === "known_contact") reasons.push("known_contact");
	if (signals.senderKind === "human" && !signals.isColdOutreach) reasons.push("human_sender");
	if (signals.gmailCategoryContradiction) reasons.push("gmail_graph_disagree");
	if (signals.isSensitive && signals.senderKind !== "bulk") reasons.push("sensitive");
	if (system1.priority >= policy.attentionCutLine - 1) reasons.push("near_attention_line");
	const highStakes = reasons.length > 0;
	if (highStakes && system1.confidence < policy.autoApplyConfidence) reasons.push("high_stakes_unsure");
	if (!highStakes && system1.confidence < policy.system2EscalationConfidence) reasons.push("low_system1_confidence");
	// High stakes the rules are already sure of (a known contact's direct ask at P6)
	// still escalate: System 2 is also where the draft and the extraction come from.
	return reasons.length > 0 ? { mode: "system_2", reasons } : { mode: "system_1", reasons: ["confident_machine_mail"] };
}

/** Map a judged thread to its natural route, before the HITL gate. */
export function routeEmail(
	assessment: EmailAssessment,
	signals: EmailSignals,
	policy: EmailHitlPolicy = DEFAULT_EMAIL_HITL_POLICY,
): EmailRoute {
	const { category, priority } = assessment;

	if (assessment.suggestedRoute && assessment.thinkingMode === "system_2") {
		const suggested = assessment.suggestedRoute;
		// A model may promote a thread to the owner, or file it; it may not invent a
		// route the category contradicts.
		if (suggested !== "draft_reply" || category === "to_respond") return suggested;
	}

	if (category === "awaiting_reply") return "awaiting_reply";
	if (category === "to_respond" && priority >= policy.attentionCutLine) {
		const canDraft =
			assessment.thinkingMode === "system_2" &&
			assessment.hasDraft === true &&
			priority >= policy.draftReplyMinPriority;
		return canDraft ? "draft_reply" : "attention";
	}
	if (priority >= policy.attentionCutLine) return "attention";
	if (category === "meeting_update") return priority >= 4 && signals.cues.meetingInvite ? "calendar" : "digest";
	if (category === "marketing") {
		return signals.hasListUnsubscribe && signals.unread ? "unsubscribe_candidate" : "archive";
	}
	if (category === "to_respond" || category === "comment") return priority >= 4 ? "digest" : "archive";
	if (category === "fyi") return priority >= 3 ? "digest" : "archive";
	return "archive";
}

export interface HitlOutcome {
	route: EmailRoute;
	/** The route the thread would have taken without the gate. */
	naturalRoute: EmailRoute;
	requiresHuman: boolean;
	/** True when the pipeline may apply the Gmail change without the owner. */
	autoApply: boolean;
	keepInInbox: boolean;
	hitlReasons: string[];
}

/**
 * The HITL rules. A thread needs the owner when any of these hold:
 * 1. it is going to the owner anyway (attention or a draft to approve),
 * 2. it is high-stakes (`isHighStakes`) and confidence sits below the auto-apply band,
 * 3. it is from a known contact and would be archived without a confident System 2 read,
 * 4. it carries a money, security or legal cue and System 2 has not cleared it,
 * 5. Gmail's tab and the graph disagree and System 2 has not resolved it.
 * Below the act floor nothing happens to the thread at all: it stays put, unlabelled.
 */
export function applyHitlPolicy(
	naturalRoute: EmailRoute,
	assessment: EmailAssessment,
	signals: EmailSignals,
	policy: EmailHitlPolicy = DEFAULT_EMAIL_HITL_POLICY,
): HitlOutcome {
	const reasons: string[] = [];
	const confident = assessment.confidence >= policy.autoApplyConfidence;
	const system2Confident = assessment.thinkingMode === "system_2" && confident;

	if (INBOX_ROUTES.has(naturalRoute)) {
		return {
			route: naturalRoute,
			naturalRoute,
			requiresHuman: true,
			autoApply: assessment.confidence >= policy.actConfidenceFloor,
			keepInInbox: true,
			hitlReasons: [`route:${naturalRoute}`],
		};
	}

	if (assessment.confidence < policy.actConfidenceFloor) {
		return {
			route: "review",
			naturalRoute,
			requiresHuman: true,
			autoApply: false,
			keepInInbox: true,
			hitlReasons: ["below_act_floor"],
		};
	}

	const highStakes = isHighStakes(signals, assessment, policy);
	if (!confident && highStakes) reasons.push("mid_confidence_high_stakes");
	if (policy.protectKnownContacts && signals.knownContact && !system2Confident) {
		reasons.push("known_contact_protected");
	}
	if (
		policy.protectKnownContacts &&
		isKeyRelationship(signals.relationship) &&
		naturalRoute === "archive" &&
		!system2Confident
	) {
		reasons.push("key_relationship_never_silently_archived");
	}
	if (policy.protectSensitive && signals.isSensitive && !system2Confident && signals.senderKind !== "bulk") {
		reasons.push("sensitive_unverified");
	}
	if (signals.gmailCategoryContradiction && !system2Confident) reasons.push("gmail_graph_disagree");

	if (reasons.length > 0) {
		return {
			route: "review",
			naturalRoute,
			requiresHuman: true,
			autoApply: true,
			keepInInbox: true,
			hitlReasons: reasons,
		};
	}

	return {
		route: naturalRoute,
		naturalRoute,
		requiresHuman: false,
		autoApply: true,
		keepInInbox: false,
		hitlReasons: [],
	};
}

export interface BudgetableDecision {
	priority: number;
	route: EmailRoute;
	received_at?: string | null;
}

export interface AttentionBudgetResult<T> {
	/** Threads the owner sees today, best first, at most the budget (priority 7 is never cut). */
	attention: T[];
	/** Threads that qualified for attention but did not fit: kept in the inbox, flagged. */
	overflow: T[];
	budget: number;
	overBudget: boolean;
}

function receivedMs(value: string | null | undefined): number {
	if (!value) return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

/**
 * Rank everything routed to the owner and enforce the daily budget. Priority 7 always
 * shows (an overflowing day should hurt, not hide a critical mail). Overflow is never
 * archived: a budget breach is a rubric problem to fix, so it is measured and surfaced.
 */
export function applyAttentionBudget<T extends BudgetableDecision>(
	decisions: readonly T[],
	budget: number = DEFAULT_EMAIL_HITL_POLICY.dailyAttentionBudget,
	alreadySurfacedToday = 0,
): AttentionBudgetResult<T> {
	const routeRank: Record<string, number> = { draft_reply: 0, attention: 1, review: 2 };
	const owed = decisions
		.filter((d) => INBOX_ROUTES.has(d.route))
		.sort((a, b) => {
			if (b.priority !== a.priority) return b.priority - a.priority;
			const r = (routeRank[a.route] ?? 9) - (routeRank[b.route] ?? 9);
			if (r !== 0) return r;
			return receivedMs(b.received_at) - receivedMs(a.received_at);
		});
	const remaining = Math.max(0, budget - alreadySurfacedToday);
	const attention: T[] = [];
	const overflow: T[] = [];
	for (const d of owed) {
		if (d.priority >= 7 || attention.length < remaining) attention.push(d);
		else overflow.push(d);
	}
	return { attention, overflow, budget, overBudget: overflow.length > 0 || attention.length > remaining };
}

export const EMAIL_DAILY_DIGEST_SUBTYPE = "email_digest_daily" as const;

export function emailDailyDigestDedupKey(date: string): string {
	return `${EMAIL_DAILY_DIGEST_SUBTYPE}:${date.trim()}`;
}

export interface EmailDailyDigestItem {
	thread_id: string;
	account: string;
	sender: string;
	subject: string;
	snippet?: string | null;
	priority?: number;
	intent_category?: EmailIntentCategory | string;
	received_at?: string | null;
	source_url?: string | null;
	route?: EmailRoute | string;
}

export interface EmailDailyDigest {
	/** Local calendar date (`YYYY-MM-DD`). */
	date: string;
	/** ISO-8601 timestamp when the digest was built or updated. */
	generated_at: string;
	/** Digest-routed thread entries for the day, deduplicated by `account:thread_id`. */
	items: EmailDailyDigestItem[];
}

export interface BuildEmailDailyDigestInput {
	date: string;
	generated_at?: string;
	items: readonly EmailDailyDigestItem[];
	existingItems?: readonly EmailDailyDigestItem[];
}

function defaultDigestThreadUrl(account: string, threadId: string): string {
	const accountIndex = account === "work" ? "1" : "0";
	return `https://mail.google.com/mail/u/${accountIndex}/#inbox/${threadId}`;
}

function normaliseDigestItem(item: EmailDailyDigestItem): EmailDailyDigestItem {
	const account = (item.account || "personal").trim() || "personal";
	const threadId = item.thread_id.trim();
	const sourceUrl =
		item.source_url && item.source_url.trim().length > 0
			? item.source_url.trim()
			: defaultDigestThreadUrl(account, threadId);
	return {
		thread_id: threadId,
		account,
		sender: (item.sender || "unknown").replace(/\s+/g, " ").trim(),
		subject: (item.subject || "(no subject)").replace(/\s+/g, " ").trim(),
		...(item.snippet !== undefined ? { snippet: item.snippet } : {}),
		...(typeof item.priority === "number" ? { priority: item.priority } : {}),
		...(item.intent_category !== undefined ? { intent_category: item.intent_category } : {}),
		...(item.received_at !== undefined ? { received_at: item.received_at } : {}),
		source_url: sourceUrl,
	};
}

/**
 * Aggregate `digest`-routed threads for a local calendar day into a single deduplicated
 * `EmailDailyDigest`. Accepts either `{ date, generated_at?, items, existingItems? }`,
 * `(date, items, options?)`, or `(items, options?)`.
 */
export function buildEmailDailyDigest(
	inputOrDateOrItems: BuildEmailDailyDigestInput | string | readonly EmailDailyDigestItem[],
	maybeItemsOrOptions?:
		| readonly EmailDailyDigestItem[]
		| { date?: string; generated_at?: string; existingItems?: readonly EmailDailyDigestItem[] },
	maybeOptions?: { generated_at?: string; existingItems?: readonly EmailDailyDigestItem[] },
): EmailDailyDigest {
	let date: string;
	let generatedAt: string;
	let rawItems: readonly EmailDailyDigestItem[];
	let existingItems: readonly EmailDailyDigestItem[] = [];

	if (typeof inputOrDateOrItems === "string") {
		date = inputOrDateOrItems.trim();
		rawItems = Array.isArray(maybeItemsOrOptions) ? maybeItemsOrOptions : [];
		generatedAt = maybeOptions?.generated_at ?? new Date().toISOString();
		existingItems = maybeOptions?.existingItems ?? [];
	} else if (Array.isArray(inputOrDateOrItems)) {
		const opts =
			maybeItemsOrOptions && !Array.isArray(maybeItemsOrOptions)
				? (maybeItemsOrOptions as {
						date?: string;
						generated_at?: string;
						existingItems?: readonly EmailDailyDigestItem[];
					})
				: undefined;
		generatedAt = opts?.generated_at ?? new Date().toISOString();
		date = (opts?.date ?? generatedAt.slice(0, 10)).trim();
		rawItems = inputOrDateOrItems;
		existingItems = opts?.existingItems ?? [];
	} else {
		const obj = inputOrDateOrItems as BuildEmailDailyDigestInput;
		generatedAt = obj.generated_at ?? new Date().toISOString();
		date = obj.date.trim();
		rawItems = obj.items ?? [];
		existingItems = obj.existingItems ?? [];
	}

	const byKey = new Map<string, EmailDailyDigestItem>();
	for (const item of [...existingItems, ...rawItems]) {
		if (!item || typeof item.thread_id !== "string" || item.thread_id.trim().length === 0) continue;
		if (item.route !== undefined && item.route !== "digest") continue;
		const normalised = normaliseDigestItem(item);
		byKey.set(`${normalised.account}:${normalised.thread_id}`, normalised);
	}

	const items = Array.from(byKey.values()).sort((a, b) => {
		const pa = typeof a.priority === "number" ? a.priority : 0;
		const pb = typeof b.priority === "number" ? b.priority : 0;
		if (pb !== pa) return pb - pa;
		return receivedMs(b.received_at) - receivedMs(a.received_at);
	});

	return {
		date,
		generated_at: generatedAt,
		items,
	};
}

/** Format one summary line per digest thread with account, sender, subject, and thread link. */
export function formatEmailDailyDigestLine(item: EmailDailyDigestItem): string {
	const normalised = normaliseDigestItem(item);
	return `- [${normalised.account}] ${normalised.sender} — ${normalised.subject} (${normalised.source_url})`;
}

/** Format a daily digest artifact markdown body with one summary line per thread. */
export function formatEmailDailyDigestMarkdown(digest: EmailDailyDigest): string {
	const lines = digest.items.map((item) => formatEmailDailyDigestLine(item));
	return [
		`# Email Daily Digest — ${digest.date}`,
		"",
		...lines,
	].join("\n");
}


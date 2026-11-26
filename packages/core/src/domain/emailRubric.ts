/**
 * @ahkms/core/domain - emailRubric.ts
 *
 * The email rubric (ADR-118): what each intent category means, what each step of the
 * universal 1..7 priority scale (ADR-116) means for a piece of mail, and the System 1
 * classifier that applies it deterministically.
 *
 * The same rubric text is rendered into the System 2 prompt, so the rules-based pass and
 * the model pass are judged against one definition. Bump EMAIL_RUBRIC_VERSION on any
 * change: every decision records the version it was judged under, which is what lets an
 * override rate be compared before and after a rubric edit.
 *
 * Isomorphic: zero Node imports.
 */

import type { EmailIntentCategory } from "./emailTriage.js";
import {
	resolveSenderOverrideRule,
	type EmailSenderOverrideFact,
	type EmailSignals,
	type SenderOverrideDirection,
} from "./emailSignals.js";

export const EMAIL_RUBRIC_VERSION = "2026-11-08.3";

export interface EmailCategoryRubricEntry {
	category: EmailIntentCategory;
	definition: string;
	include: readonly string[];
	exclude: readonly string[];
}

export const EMAIL_CATEGORY_RUBRIC: readonly EmailCategoryRubricEntry[] = Object.freeze([
	{
		category: "to_respond",
		definition: "A person expects the owner to reply, decide or act, and nobody else will.",
		include: [
			"a direct question or request from a human",
			"an investor, partner, customer or co-founder asking for something",
			"a share or access request from a known person",
		],
		exclude: [
			"marketing copy phrased as a question",
			"a cold sales pitch from a stranger the owner has never written to, however personal it reads",
			"automated mail that says 'action required' about an account setting",
		],
	},
	{
		category: "awaiting_reply",
		definition: "The owner sent the last message and the next move is someone else's.",
		include: ["a thread whose latest message is from the owner"],
		exclude: ["the owner's own digests and notes to self"],
	},
	{
		category: "meeting_update",
		definition: "Calendar traffic: invitations, changes, responses, reminders and meeting notes.",
		include: ["Invitation:", "Updated invitation:", "Accepted:", "Declined:", "Notes: ...", "reminders"],
		exclude: ["event marketing (tickets, webinars) from a list"],
	},
	{
		category: "comment",
		definition: "Someone commented on, mentioned or shared a document or work item.",
		include: ["Google Docs comments", "Notion and GitHub mentions", "documents shared with the owner"],
		exclude: ["social network likes and follows"],
	},
	{
		category: "fyi",
		definition: "Worth knowing, nothing to do: updates from people or systems the owner cares about.",
		include: [
			"the owner's own Morning Briefing",
			"ahOS system alerts",
			"product and policy notices from services the owner uses",
			"investor and industry newsletters the owner reads",
		],
		exclude: ["anything with an explicit ask of the owner"],
	},
	{
		category: "notification",
		definition: "Machine-sent status: receipts, billing, CI, account and social notifications.",
		include: ["receipts", "usage and billing alerts", "TestFlight builds", "follows and likes"],
		exclude: ["security incidents affecting the owner's data (those are fyi at least)"],
	},
	{
		category: "actioned",
		definition: "Already handled: the owner replied, the task is closed or the event is past.",
		include: ["threads closed by a linked done task"],
		exclude: [],
	},
	{
		category: "marketing",
		definition: "Promotional or bulk mail sent to a list to sell or engage.",
		include: [
			"discounts and sales",
			"brand newsletters",
			"event promotion",
			"cold sales outreach from someone the owner has never written to, even when a person wrote it and Gmail filed it in Primary",
		],
		exclude: ["mail from a known contact, even if Gmail filed it under Promotions"],
	},
]);

export interface EmailPriorityRubricEntry {
	level: number;
	title: string;
	meaning: string;
	examples: readonly string[];
}

export const EMAIL_PRIORITY_RUBRIC: readonly EmailPriorityRubricEntry[] = Object.freeze([
	{
		level: 7,
		title: "Critical",
		meaning: "Material harm today if ignored: money, legal, security or a key relationship at stake.",
		examples: ["co-founder or investor blocker with a same-day deadline", "a breach of the owner's own account"],
	},
	{
		level: 6,
		title: "Urgent",
		meaning: "A key person needs a reply within 24 hours.",
		examples: ["investor asking for the deck this week", "a customer escalation"],
	},
	{
		level: 5,
		title: "High",
		meaning: "A known human asks something of the owner directly; reply within two or three days.",
		examples: ["a partner proposing a call", "a share request from a known contact"],
	},
	{
		level: 4,
		title: "Normal",
		meaning: "Human mail without a direct ask, or an invitation that needs an RSVP.",
		examples: ["a meeting invitation", "an intro email the owner was copied on"],
	},
	{
		level: 3,
		title: "Low",
		meaning: "Relevant to the owner's work, nothing to do now.",
		examples: ["ahOS alerts", "Vercel domain configuration notices", "the Morning Briefing"],
	},
	{
		level: 2,
		title: "Minor",
		meaning: "Routine machine mail the owner might glance at.",
		examples: ["receipts", "weekly reports", "policy and terms updates"],
	},
	{
		level: 1,
		title: "Trivial",
		meaning: "No consequence if never read.",
		examples: ["retail promotions", "social notifications", "event marketing"],
	},
]);

/** The four questions a priority judgement answers, in the order they are weighed. */
export const EMAIL_PRIORITY_FACTORS = Object.freeze([
	"who: is the sender a key person, a known contact, a stranger or a machine (knowledge graph first, Gmail never)",
	"ask: does the mail ask the owner, by name and directly, to reply, decide or do something",
	"time: is there a deadline or a same-week consequence",
	"stakes: money, legal, security, an active deal or project in the State Doc",
]);

export interface System1Assessment {
	category: EmailIntentCategory;
	priority: number;
	/** How sure the rules are, 0..1. Below the auto-apply band the thread escalates to System 2. */
	confidence: number;
	reasons: string[];
}

function clamp(priority: number): number {
	return Math.min(7, Math.max(1, Math.round(priority)));
}

const KEY_RELATIONSHIP_PATTERN =
	/\b(co-?founder|founder|investor|advisor|board|partner|customer|client|family|father|mother|dad|mum|brother|sister|wife|husband|partner|fianc[eé]e?)\b/i;

export function isKeyRelationship(relationship: string | null | undefined): boolean {
	return typeof relationship === "string" && KEY_RELATIONSHIP_PATTERN.test(relationship);
}

export interface AssessEmailSystem1Options {
	senderOverrides?: readonly EmailSenderOverrideFact[];
	senderOverrideDirection?: SenderOverrideDirection | null;
}

/**
 * The System 1 pass: deterministic category, priority and confidence from signals alone.
 *
 * Confidence is deliberately low wherever the rules are guessing about a human. Rules
 * are good at recognising machines and bad at weighing people, so a human sender rarely
 * clears the auto-apply band here and goes to System 2 (or to review when no model is
 * wired).
 */
export function assessEmailSystem1(
	signals: EmailSignals,
	options: AssessEmailSystem1Options = {},
): System1Assessment {
	const reasons: string[] = [`sender:${signals.senderKind}`];
	const { cues } = signals;
	if (signals.gmailCategory !== "unknown") reasons.push(`gmail_category:${signals.gmailCategory}`);
	if (signals.gmailCategoryContradiction) reasons.push("gmail_category_contradicted");

	// 1. The owner's own mail sitting in the inbox: digests, notes to self, alerts.
	if (signals.senderKind === "self") {
		reasons.push("self_sent");
		return { category: "fyi", priority: 3, confidence: 0.92, reasons };
	}

	// 1b. Repeated same-direction owner corrections (>= 2) promote the sender to a deterministic System 1 rule.
	const learnedRule = options.senderOverrideDirection
		? { direction: options.senderOverrideDirection, count: 2 }
		: options.senderOverrides
			? resolveSenderOverrideRule(signals.senderAddress, options.senderOverrides)
			: signals.learnedSenderOverride
				? { direction: signals.learnedSenderOverride, count: signals.senderOverrideCount ?? 2 }
				: null;
	if (learnedRule) {
		if (learnedRule.direction === "to_respond") {
			reasons.push("learned_sender_override:to_respond");
			return {
				category: "to_respond",
				priority: clamp(cues.urgency || cues.deadline ? 6 : 5),
				confidence: 0.95,
				reasons,
			};
		}
		if (learnedRule.direction === "archive" && !signals.isSensitive) {
			reasons.push("learned_sender_override:archive");
			return {
				category: "marketing",
				priority: 1,
				confidence: 0.95,
				reasons,
			};
		}
	}

	// 2. Systems the owner runs.
	if (signals.isSystemAlert) {
		reasons.push("system_alert");
		return { category: "fyi", priority: 3, confidence: 0.9, reasons };
	}

	// 3. Calendar traffic.
	if (cues.meetingResponse) {
		reasons.push("meeting_response");
		return { category: "meeting_update", priority: 2, confidence: 0.93, reasons };
	}
	if (cues.meetingNotes) {
		reasons.push("meeting_notes");
		return { category: "meeting_update", priority: 3, confidence: 0.9, reasons };
	}
	if (cues.meetingInvite) {
		reasons.push("meeting_invite");
		const fromPerson = signals.senderKind === "known_contact" || signals.senderKind === "human";
		return { category: "meeting_update", priority: 4, confidence: fromPerson ? 0.8 : 0.88, reasons };
	}

	// 4. Known contacts: the graph outranks every Gmail label.
	if (signals.senderKind === "known_contact") {
		const key = isKeyRelationship(signals.relationship);
		if (key) reasons.push(`key_relationship:${signals.relationship}`);
		let priority = cues.ask ? 5 : 4;
		if (key) priority += 1;
		if (cues.urgency || cues.deadline) {
			priority += 1;
			reasons.push("time_pressure");
		}
		if (signals.isSensitive) {
			priority += 1;
			reasons.push("sensitive");
		}
		if (cues.sharedDocument) reasons.push("shared_document");
		if (cues.ask) reasons.push("direct_ask");
		return {
			category: cues.ask || cues.sharedDocument ? "to_respond" : "fyi",
			priority: clamp(priority),
			confidence: 0.7,
			reasons,
		};
	}

	// 5. Bulk mail with list headers: the strongest machine evidence there is.
	if (signals.senderKind === "bulk") {
		if (signals.cues.security) {
			reasons.push("security_notice");
			return { category: "fyi", priority: 3, confidence: 0.75, reasons };
		}
		if (cues.promo || signals.gmailCategory === "promotions") {
			reasons.push("promotional_bulk");
			return { category: "marketing", priority: 1, confidence: 0.96, reasons };
		}
		if (cues.socialNotification || signals.gmailCategory === "social") {
			reasons.push("social_bulk");
			return { category: "notification", priority: 1, confidence: 0.94, reasons };
		}
		if (cues.receipt || cues.money) {
			reasons.push("transactional_bulk");
			return { category: "notification", priority: 2, confidence: 0.85, reasons };
		}
		reasons.push("list_mail");
		return { category: "marketing", priority: 1, confidence: 0.88, reasons };
	}

	// 6. Automated, no list headers: transactional and account mail.
	if (signals.senderKind === "automated") {
		if (cues.security) {
			reasons.push("security_notice");
			return { category: "fyi", priority: 4, confidence: 0.7, reasons };
		}
		if (cues.sharedDocument) {
			reasons.push("shared_document");
			return { category: "comment", priority: 4, confidence: 0.65, reasons };
		}
		if (cues.money && !cues.receipt) {
			reasons.push("money_notice");
			return { category: "notification", priority: 3, confidence: 0.7, reasons };
		}
		if (cues.socialNotification) {
			reasons.push("social_notification");
			return { category: "notification", priority: 1, confidence: 0.93, reasons };
		}
		if (cues.receipt) {
			reasons.push("receipt");
			return { category: "notification", priority: 2, confidence: 0.9, reasons };
		}
		if (cues.promo || signals.gmailCategory === "promotions") {
			reasons.push("promotional_automated");
			// Gmail's Promotions tab alone is a prior, not proof: confidence stays below auto-apply.
			return { category: "marketing", priority: 1, confidence: cues.promo ? 0.9 : 0.8, reasons };
		}
		reasons.push("automated_notice");
		return { category: "notification", priority: 2, confidence: 0.82, reasons };
	}

	// 7. A human the graph does not know.
	if (signals.isColdOutreach) {
		// Golden example 1 (Spendbase): a person selling, never answered. Archive.
		reasons.push("cold_outreach");
		return { category: "marketing", priority: 1, confidence: 0.9, reasons };
	}
	if (cues.salesPitch) {
		reasons.push(signals.ownerHasWritten === null ? "sales_pitch_history_unknown" : "sales_pitch_known_correspondent");
	}
	let priority = 3;
	if (signals.isDirectRecipient) {
		priority += 1;
		reasons.push("direct_recipient");
	} else if (signals.isCcOnly) {
		reasons.push("cc_only");
	}
	if (cues.ask) {
		priority += 1;
		reasons.push("direct_ask");
	}
	if (cues.urgency || cues.deadline) {
		priority += 1;
		reasons.push("time_pressure");
	}
	if (signals.isSensitive) {
		priority += 1;
		reasons.push("sensitive");
	}
	if (cues.promo) {
		priority -= 2;
		reasons.push("promotional_language");
	}
	return {
		category: cues.ask ? "to_respond" : cues.promo ? "marketing" : "fyi",
		priority: clamp(priority),
		confidence: 0.55,
		reasons,
	};
}

/** The rubric as prompt text for the System 2 reasoner. One rendering, one source. */
export function renderEmailRubricForPrompt(): string {
	const categories = EMAIL_CATEGORY_RUBRIC.map(
		(entry) =>
			`- ${entry.category}: ${entry.definition}` +
			(entry.include.length ? ` Includes: ${entry.include.join("; ")}.` : "") +
			(entry.exclude.length ? ` Excludes: ${entry.exclude.join("; ")}.` : ""),
	).join("\n");
	const priorities = EMAIL_PRIORITY_RUBRIC.map(
		(entry) => `- ${entry.level} ${entry.title}: ${entry.meaning} e.g. ${entry.examples.join("; ")}.`,
	).join("\n");
	const factors = EMAIL_PRIORITY_FACTORS.map((f) => `- ${f}`).join("\n");
	return [
		`Email rubric version ${EMAIL_RUBRIC_VERSION}.`,
		"",
		"Intent categories (pick exactly one):",
		categories,
		"",
		"Priority on the 1..7 scale (7 highest):",
		priorities,
		"",
		"Weigh priority by:",
		factors,
		"",
		"Gmail's own tabs (Promotions, Updates, Social) are often wrong. Never let them outrank the sender's relationship or a direct ask.",
	].join("\n");
}

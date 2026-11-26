/**
 * @ahkms/core/domain - emailFastPath.ts
 *
 * The first micro test of the fanned-out email pipeline: "is this email worth
 * analysis?" One yes/no question for a logprob judge (#2121), asked of every thread
 * before any of the costlier decisions (needs a reply? owner commitment open? new
 * person for the graph?). A thread only skips analysis on a confident "no"; any
 * doubt, or no judge answer at all, means analyse.
 *
 * Isomorphic: zero Node imports.
 */
import type { DecisionJudgeQuestion, DecisionJudgeResult } from "../ports/decisionJudge.js";
import type { EmailSignals } from "./emailSignals.js";

export const EMAIL_FAST_PATH_VERSION = "2026-11-08.2";

/** Skip analysis only when the judge says "no" at least this surely (RLCD-calibrated p(no) >= 0.75, i.e. p(yes) <= 0.25). */
export const EMAIL_FAST_PATH_SKIP_CONFIDENCE = 0.75;

const BODY_CHARS = 1500;

export interface EmailFastPathInput {
	from: string;
	to?: string | null;
	cc?: string | null;
	subject?: string | null;
	/** The latest message's text (or snippet). Quoted history is fine; it is cut. */
	text?: string | null;
	signals: Pick<
		EmailSignals,
		| "senderKind"
		| "isDirectRecipient"
		| "isCcOnly"
		| "gmailCategory"
		| "hasBulkHeaders"
		| "knownContact"
		| "relationship"
		| "ownerHasWritten"
	>;
}

export const EMAIL_FAST_PATH_SYSTEM = [
	"You screen incoming email for Angus, a founder with a personal and a company mailbox.",
	"You answer one question with one word: yes or no.",
].join(" ");

function yn(value: boolean | null | undefined): string {
	return value === null || value === undefined ? "unknown" : value ? "yes" : "no";
}

export function buildWorthAnalysisQuestion(input: EmailFastPathInput, id = "worth_analysis"): DecisionJudgeQuestion {
	const s = input.signals;
	const text = (input.text ?? "").replace(/\s+/g, " ").trim().slice(0, BODY_CHARS);
	const prompt = [
		"Question: is this email worth a closer look before it is filed?",
		"Answer yes if it might need anything from Angus (a reply, a decision, an action, a date to keep)",
		"or carries facts he keeps track of (a relationship, a deal, a commitment, money spent or billed, receipts, invoices, security, legal),",
		"even if a closer look concludes no human action is needed and the system only records the facts.",
		"Answer no only if it can be filed on sight with nothing to record: marketing, newsletters, cold sales pitches,",
		"routine notifications, social alerts.",
		"",
		"Evidence (Gmail's tab is often wrong):",
		`- From: ${input.from}`,
		`- To: ${input.to ?? ""}${input.cc ? `; Cc: ${input.cc}` : ""}`,
		`- Angus is a direct recipient: ${yn(s.isDirectRecipient)}; cc only: ${yn(s.isCcOnly)}`,
		`- Sender kind from headers: ${s.senderKind}; mailing-list headers: ${yn(s.hasBulkHeaders)}`,
		`- Sender in Angus's contacts graph: ${yn(s.knownContact)}${s.relationship ? ` (${s.relationship})` : ""}`,
		`- Angus has emailed this sender before: ${yn(s.ownerHasWritten)}`,
		`- Gmail tab: ${s.gmailCategory}`,
		`- Subject: ${input.subject ?? ""}`,
		`- Latest message: ${text}`,
		"",
		"Answer yes or no.",
	].join("\n");
	return { kind: "noul", id, prompt, system: EMAIL_FAST_PATH_SYSTEM };
}

export interface EmailFastPathVerdict {
	/** True: run the full analysis. False: file on sight. */
	analyse: boolean;
	/** Probability the judge gave "yes, worth analysis"; null when it did not answer. */
	pYes: number | null;
	reason: "judge_yes" | "judge_unsure" | "judge_confident_no" | "no_judge";
}

/** Fail open: only a confident "no" skips analysis. */
export function decideFastPath(
	result: DecisionJudgeResult | null,
	skipConfidence = EMAIL_FAST_PATH_SKIP_CONFIDENCE,
): EmailFastPathVerdict {
	if (!result) return { analyse: true, pYes: null, reason: "no_judge" };
	const pYes = result.distribution.yes ?? 0;
	const pNo = result.distribution.no ?? 1 - pYes;
	if (pNo >= skipConfidence) return { analyse: false, pYes, reason: "judge_confident_no" };
	return { analyse: true, pYes, reason: pYes >= 0.5 ? "judge_yes" : "judge_unsure" };
}

export const EMAIL_CONTEXT_PROBES = [
	"calendar",
	"tasks",
	"drive",
	"graph_artifacts",
	"unverifiable_external",
] as const;

export type EmailContextProbeKind = (typeof EMAIL_CONTEXT_PROBES)[number];

export function renderEmailEvidenceState(input: EmailFastPathInput): string {
	const s = input.signals;
	const text = (input.text ?? "").replace(/\s+/g, " ").trim().slice(0, BODY_CHARS);
	return [
		"Evidence (Gmail's tab is often wrong):",
		`- From: ${input.from}`,
		`- To: ${input.to ?? ""}${input.cc ? `; Cc: ${input.cc}` : ""}`,
		`- Angus is a direct recipient: ${yn(s.isDirectRecipient)}; cc only: ${yn(s.isCcOnly)}`,
		`- Sender kind from headers: ${s.senderKind}; mailing-list headers: ${yn(s.hasBulkHeaders)}`,
		`- Sender in Angus's contacts graph: ${yn(s.knownContact)}${s.relationship ? ` (${s.relationship})` : ""}`,
		`- Angus has emailed this sender before: ${yn(s.ownerHasWritten)}`,
		`- Gmail tab: ${s.gmailCategory}`,
		`- Subject: ${input.subject ?? ""}`,
		`- Thread text (latest message first, followed by quoted prior messages if any): ${text}`,
	].join("\n");
}

function makeNoulQuestion(id: string, state: string, instructions: string): DecisionJudgeQuestion {
	return {
		kind: "noul",
		id,
		state,
		instructions,
		system: EMAIL_FAST_PATH_SYSTEM,
		prompt: `${instructions}\n\n${state}\n\nAnswer yes or no.`,
	};
}

/**
 * Stage 2 Hop 1: Email-only fan-out + context router. Evaluates all 8 questions in a
 * single Jev `/v1/systemone` forward pass (~160ms, 0 extra state tokens).
 */
export function buildHop1FanOutQuestions(input: EmailFastPathInput): DecisionJudgeQuestion[] {
	const state = renderEmailEvidenceState(input);
	return [
		makeNoulQuestion(
			"needs_reply",
			state,
			"Question: Does the sender expect Angus to reply to the latest message? Answer no if the latest message merely confirms a time, says thanks, or is an automated receipt/notification.",
		),
		makeNoulQuestion(
			"has_owner_commitment",
			state,
			"Question: Does this thread contain a future promise, follow-up action, or open request that Angus still needs to carry out or verify outside this email (for example 'I'll send new invite', 'I will review', a document share request to approve, or an alert requiring configuration)? Answer no if Angus already delivered the answer in the quoted email and the latest message is just a 'Thanks'.",
		),
		makeNoulQuestion(
			"has_fact_to_persist",
			state,
			"Question: Does this email record a durable fact ahOS should store (money spent or billed, a receipt or invoice, a confirmed meeting date/time, a deal/contract term, or a security/account incident)?",
		),
		makeNoulQuestion(
			"probe_calendar",
			state,
			"Question: Does this thread mention a specific meeting, call, coaching session, or calendar invite on a date/time that could be checked on Angus's calendar?",
		),
		makeNoulQuestion(
			"probe_tasks",
			state,
			"Question: Does this thread refer to a to-do, deliverable, or open task (other than a calendar invite) that could be checked in Angus's task list?",
		),
		makeNoulQuestion(
			"probe_drive",
			state,
			"Question: Does this thread ask for access to, or reference, a specific Google Drive document, spreadsheet, or file?",
		),
		makeNoulQuestion(
			"probe_graph_artifacts",
			state,
			"Question: Is this a receipt, billing statement, or status update where checking already-captured artifacts or connected data sources would tell us if it is already recorded?",
		),
		makeNoulQuestion(
			"probe_unverifiable_external",
			state,
			"Question: Does resolving this require checking or changing an external third-party console or dashboard outside Gmail, Calendar, Drive, and Tasks (for example a GCP console, Vercel DNS settings, or a bank portal)?",
		),
	];
}

export interface EmailHop1Verdict {
	needs_reply: boolean;
	has_owner_commitment: boolean;
	has_fact_to_persist: boolean;
	is_new_contact: boolean;
	/** True when the sender matched an existing `people` row by name whose `email` column is still null. */
	needs_contact_email_backfill: boolean;
	probes: EmailContextProbeKind[];
	needs_hop2: boolean;
	probabilities: Record<string, number>;
}

export function decideHop1FanOut(
	results: Record<string, DecisionJudgeResult> | null,
	signals: Pick<EmailSignals, "knownContact" | "ownerHasWritten" | "senderKind"> &
		Partial<Pick<EmailSignals, "contactMissingEmail" | "senderAddress">>,
	yesThreshold = 0.5,
): EmailHop1Verdict {
	const p = (id: string) => results?.[id]?.distribution.yes ?? 0;
	const yes = (id: string) => p(id) >= yesThreshold;

	const needs_reply = results ? yes("needs_reply") : true;
	const has_owner_commitment = results ? yes("has_owner_commitment") : false;
	const has_fact_to_persist = results ? yes("has_fact_to_persist") : false;
	const is_new_contact = !signals.knownContact && signals.ownerHasWritten === true && signals.senderKind === "human";
	const needs_contact_email_backfill = Boolean(
		signals.knownContact && signals.contactMissingEmail && signals.senderAddress,
	);

	const probes: EmailContextProbeKind[] = [];
	if (yes("probe_calendar")) probes.push("calendar");
	if (yes("probe_tasks")) probes.push("tasks");
	if (yes("probe_drive")) probes.push("drive");
	if (yes("probe_graph_artifacts")) probes.push("graph_artifacts");
	if (yes("probe_unverifiable_external")) probes.push("unverifiable_external");

	const hasInternalProbe = probes.some((pr) => pr !== "unverifiable_external");
	const needs_hop2 = (has_owner_commitment || needs_reply) && hasInternalProbe;

	const probabilities: Record<string, number> = {};
	if (results) {
		for (const [k, v] of Object.entries(results)) {
			probabilities[k] = v.distribution.yes ?? 0;
		}
	}

	return {
		needs_reply,
		has_owner_commitment,
		has_fact_to_persist,
		is_new_contact,
		needs_contact_email_backfill,
		probes,
		needs_hop2,
		probabilities,
	};
}

export interface EmailHop2ProbeEvidence {
	calendarEvents?: readonly string[];
	openTasks?: readonly string[];
	completedTasks?: readonly string[];
	driveFiles?: readonly string[];
	graphArtifacts?: readonly string[];
}

export function renderHop2ProbeEvidence(evidence: EmailHop2ProbeEvidence): string {
	const lines: string[] = ["Fetched ahOS context from probed sources:"];
	if (evidence.calendarEvents) {
		lines.push(
			`- Calendar events matching thread/date: ${evidence.calendarEvents.length > 0 ? evidence.calendarEvents.join("; ") : "none"}`,
		);
	}
	if (evidence.openTasks) {
		lines.push(`- Open tasks matching thread/sender: ${evidence.openTasks.length > 0 ? evidence.openTasks.join("; ") : "none"}`);
	}
	if (evidence.completedTasks) {
		lines.push(
			`- Completed tasks matching thread/sender: ${evidence.completedTasks.length > 0 ? evidence.completedTasks.join("; ") : "none"}`,
		);
	}
	if (evidence.driveFiles) {
		lines.push(`- Drive files/permissions: ${evidence.driveFiles.length > 0 ? evidence.driveFiles.join("; ") : "none"}`);
	}
	if (evidence.graphArtifacts) {
		lines.push(
			`- Existing graph artifacts / tracked sources: ${evidence.graphArtifacts.length > 0 ? evidence.graphArtifacts.join("; ") : "none"}`,
		);
	}
	return lines.join("\n");
}

/**
 * Stage 2 Hop 2: Context-enriched resolution over the email + fetched probe evidence.
 * Asks 1.2 (already satisfied?), 1.3 (adds info to existing item?), and 1.4 (needs escalation?)
 * in a single Jev forward pass.
 */
export function buildHop2ResolutionQuestions(
	input: EmailFastPathInput,
	probeEvidence: EmailHop2ProbeEvidence,
): DecisionJudgeQuestion[] {
	const state = `${renderEmailEvidenceState(input)}\n\n${renderHop2ProbeEvidence(probeEvidence)}`;
	return [
		makeNoulQuestion(
			"commitment_already_satisfied",
			state,
			"Question: Looking at the fetched Calendar / Tasks / Drive / Graph evidence alongside the email, is the action or commitment Angus had in this thread (such as sending a calendar invite or completing a task) already scheduled or completed?",
		),
		makeNoulQuestion(
			"adds_info_to_existing_item",
			state,
			"Question: Does the latest email change the agreed time/scope or add new requirements that require updating the existing calendar event or task (beyond simply confirming that the scheduled time works)?",
		),
		makeNoulQuestion(
			"needs_owner_escalation",
			state,
			"Question: Given the fetched evidence and the latest message, does Angus still need to personally take action or reply right now?",
		),
	];
}

export interface EmailHop2Verdict {
	commitment_already_satisfied: boolean;
	adds_info_to_existing_item: boolean;
	needs_owner_escalation: boolean;
	route: "attention" | "archive";
	probabilities: Record<string, number>;
}

export function decideHop2Resolution(
	hop1: EmailHop1Verdict,
	hop2Results: Record<string, DecisionJudgeResult> | null,
	yesThreshold = 0.5,
): EmailHop2Verdict {
	const p = (id: string) => hop2Results?.[id]?.distribution.yes ?? 0;
	const yes = (id: string) => p(id) >= yesThreshold;

	const commitment_already_satisfied = hop2Results ? yes("commitment_already_satisfied") : false;
	const adds_info_to_existing_item = hop2Results ? yes("adds_info_to_existing_item") : false;
	const needs_owner_escalation = hop2Results
		? yes("needs_owner_escalation")
		: hop1.needs_reply || (hop1.has_owner_commitment && !commitment_already_satisfied);

	const route = needs_owner_escalation ? "attention" : "archive";

	const probabilities: Record<string, number> = {};
	if (hop2Results) {
		for (const [k, v] of Object.entries(hop2Results)) {
			probabilities[k] = v.distribution.yes ?? 0;
		}
	}

	return {
		commitment_already_satisfied,
		adds_info_to_existing_item,
		needs_owner_escalation,
		route,
		probabilities,
	};
}


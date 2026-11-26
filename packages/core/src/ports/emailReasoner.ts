/**
 * @ahkms/core/ports - emailReasoner.ts
 *
 * The System 2 port of the email pipeline (ADR-118): one model call per escalated
 * thread that reads the thread together with what the owner's knowledge graph and State
 * Doc say about its sender and subject, and returns a judgement against the rubric, an
 * optional reply draft, and the tasks and entities the mail carries.
 *
 * Pure types only.
 */

import type { EmailIntentCategory } from "../domain/emailTriage.js";
import type { EmailRoute } from "../domain/emailRouting.js";
import type { EmailSignals, GmailCategory, SenderKind } from "../domain/emailSignals.js";
import type { System1Assessment } from "../domain/emailRubric.js";

export interface EmailSenderProfile {
	entity_id?: string | null;
	name?: string | null;
	relationship?: string | null;
	organization?: string | null;
	role?: string | null;
	last_contact?: string | null;
}

export interface EmailRelatedEntity {
	id: string;
	name: string;
	type?: string | null;
}

export interface EmailOpenTask {
	title: string;
	status?: string | null;
	url?: string | null;
}

export interface EmailCorrectionVerdict {
	category?: EmailIntentCategory | string | null;
	priority?: number | null;
	route?: EmailRoute | string | null;
}

/** One owner correction rendered as a worked few-shot example in the System 2 prompt. */
export interface EmailOwnerCorrectionExample {
	sender?: string | null;
	subject?: string | null;
	sender_kind: SenderKind | string;
	gmail_category: GmailCategory | string;
	system_1_verdict: string | EmailCorrectionVerdict;
	owner_verdict: string | EmailCorrectionVerdict;
	reason?: string | null;
}

/** What the owner's own systems know that bears on this thread. */
export interface EmailReasonerContext {
	sender_profile?: EmailSenderProfile | null;
	related_entities?: readonly EmailRelatedEntity[];
	open_tasks?: readonly EmailOpenTask[];
	/** A bounded excerpt of the domain's State Doc: current priorities, open actions. */
	state_doc_excerpt?: string | null;
	/** Recent owner overrides rendered as worked few-shot examples in the System 2 prompt. */
	recent_corrections?: readonly EmailOwnerCorrectionExample[];
	/** Alias for `recent_corrections`. */
	owner_corrections?: readonly EmailOwnerCorrectionExample[];
}

export interface EmailReasonerRequest {
	account: string;
	thread_id: string;
	sender: string;
	subject: string;
	snippet?: string | null;
	/** The latest message body, already truncated by the caller. */
	body?: string | null;
	received_at?: string | null;
	signals: EmailSignals;
	system1: System1Assessment;
	context: EmailReasonerContext;
	/** Ask for a reply draft (only when the thread may be a to_respond). */
	want_draft: boolean;
	/** Ask for entity and task extraction. */
	want_extraction: boolean;
}

export interface ExtractedEmailTask {
	title: string;
	due?: string | null;
	confidence: number;
}

export interface ExtractedEmailEntity {
	name: string;
	type: "person" | "organization" | "project" | "event" | "other";
	email?: string | null;
	role?: string | null;
}

export interface EmailReasonerAssessment {
	category: EmailIntentCategory;
	priority: number;
	confidence: number;
	rationale: string;
	needs_reply: boolean;
	suggested_route?: EmailRoute | null;
	draft_reply?: string | null;
	tasks: ExtractedEmailTask[];
	entities: ExtractedEmailEntity[];
	model?: string | null;
}

export interface EmailReasonerPort {
	/** Null when the model failed or returned something unusable: the caller keeps System 1. */
	assess(request: EmailReasonerRequest): Promise<EmailReasonerAssessment | null>;
}

/**
 * @ahkms/core/adapters - LLM-backed EmailReasonerPort (ADR-118).
 *
 * Wraps any `(system, prompt) -> JSON text` model call, normally the derive LLM port
 * (`createDeriveLlmPort`, Gemini by default), so System 2 needs no new SDK or key. The
 * adapter owns the prompt (rubric, context, tone rules for drafts) and the parse. Any
 * failure returns null: the pipeline then keeps the System 1 judgement and the HITL
 * gate sends the thread for review, which is the safe direction to fail in.
 */

import { z } from "zod";
import { EMAIL_INTENT_CATEGORIES } from "../../domain/emailTriage.js";
import { EMAIL_ROUTES } from "../../domain/emailRouting.js";
import { renderEmailRubricForPrompt } from "../../domain/emailRubric.js";
import type { DeriveLlmRequest, DeriveLlmResponse } from "../../actions/domain/derivePorts.js";
import type {
	EmailCorrectionVerdict,
	EmailReasonerAssessment,
	EmailReasonerPort,
	EmailReasonerRequest,
} from "../../ports/emailReasoner.js";

export type EmailReasonerLlm = (request: DeriveLlmRequest) => Promise<DeriveLlmResponse>;

const MAX_BODY_CHARS = 6000;
const MAX_STATE_DOC_CHARS = 3000;
export const MAX_CORRECTION_EXAMPLES = 5;

function formatCorrectionVerdict(verdict: string | EmailCorrectionVerdict): string {
	if (typeof verdict === "string") return verdict;
	const parts: string[] = [];
	if (verdict.category) parts.push(verdict.category);
	if (typeof verdict.priority === "number") parts.push(`P${verdict.priority}`);
	if (verdict.route) parts.push(`(${verdict.route})`);
	return parts.join(" ") || "unknown";
}

const assessmentSchema = z.object({
	category: z.enum(EMAIL_INTENT_CATEGORIES),
	priority: z.coerce.number().int().min(1).max(7),
	confidence: z.coerce.number().min(0).max(1),
	rationale: z.string().default(""),
	needs_reply: z.boolean().default(false),
	suggested_route: z.enum(EMAIL_ROUTES).nullable().optional(),
	draft_reply: z.string().nullable().optional(),
	tasks: z
		.array(
			z.object({
				title: z.string().min(1),
				due: z.string().nullable().optional(),
				confidence: z.coerce.number().min(0).max(1).default(0.5),
			}),
		)
		.default([]),
	entities: z
		.array(
			z.object({
				name: z.string().min(1),
				type: z.enum(["person", "organization", "project", "event", "other"]).catch("other"),
				email: z.string().nullable().optional(),
				role: z.string().nullable().optional(),
			}),
		)
		.default([]),
});

/** The owner's standing tone rules that a reply draft must follow. */
export const DEFAULT_DRAFT_TONE_RULES = Object.freeze([
	"Plain British English, direct and warm, no corporate fluff.",
	"Never use the em dash; use commas, semicolons, parentheses or full stops.",
	"Match the sender's register and length; most replies are two to five sentences.",
	"Never commit the owner to money, legal terms, dates or meetings not already agreed in the thread; leave a [bracketed placeholder] instead.",
	"Sign off with the owner's first name only.",
]);

export function buildEmailReasonerSystemPrompt(toneRules: readonly string[] = DEFAULT_DRAFT_TONE_RULES): string {
	return [
		"You triage email for one busy founder (the owner). Judge each thread against the rubric below and return JSON only.",
		"The goal is that fewer than 15 threads a day reach the owner, and that those are the right ones. Be conservative about archiving mail from real people, generous about filing machine mail.",
		"",
		renderEmailRubricForPrompt(),
		"",
		"Routes you may suggest: attention (owner must look), draft_reply (owner must reply and you drafted it), review (you are unsure), calendar, awaiting_reply, digest (read later in a summary), archive, unsubscribe_candidate.",
		"Confidence is your probability that the category AND the route are right. Use 0.9 or more only when you would bet on it.",
		"",
		"When asked for a draft, write the reply the owner would send. Tone rules:",
		...toneRules.map((r) => `- ${r}`),
		"",
		"When asked for extraction, list only concrete commitments or asks that the owner must act on as tasks (imperative, under 12 words), and only real named people, organisations, projects or events as entities.",
		"",
		'Return exactly: {"category": string, "priority": 1-7, "confidence": 0-1, "rationale": string (one sentence), "needs_reply": boolean, "suggested_route": string|null, "draft_reply": string|null, "tasks": [{"title", "due", "confidence"}], "entities": [{"name", "type", "email", "role"}]}',
	].join("\n");
}

export function buildEmailReasonerPrompt(request: EmailReasonerRequest): string {
	const { signals, system1, context } = request;
	const lines: string[] = [
		`Mailbox: ${request.account}`,
		`From: ${request.sender}`,
		`Subject: ${request.subject}`,
		request.received_at ? `Received: ${request.received_at}` : "",
		"",
		"Signals (deterministic):",
		`- sender kind: ${signals.senderKind}; direct recipient: ${signals.isDirectRecipient}; cc only: ${signals.isCcOnly}`,
		`- owner has written to this sender before: ${signals.ownerHasWritten === null ? "unknown" : signals.ownerHasWritten}; sales-pitch language: ${signals.cues.salesPitch}`,
		`- Gmail tab: ${signals.gmailCategory} (a weak prior, often wrong); Gmail important: ${signals.gmailImportant}`,
		`- list headers: ${signals.hasBulkHeaders}; sensitive (money/security/legal): ${signals.isSensitive}`,
		`- rules pass: ${system1.category}, priority ${system1.priority}, confidence ${system1.confidence} (${system1.reasons.join(", ")})`,
	];

	const profile = context.sender_profile;
	lines.push("", "Knowledge graph:");
	if (profile) {
		lines.push(
			`- sender is known: ${[profile.name, profile.relationship, profile.role, profile.organization]
				.filter(Boolean)
				.join(", ")}${profile.last_contact ? `; last contact ${profile.last_contact}` : ""}`,
		);
	} else {
		lines.push("- sender is not in the graph");
	}
	for (const entity of context.related_entities ?? []) {
		lines.push(`- related ${entity.type ?? "entity"}: ${entity.name}`);
	}
	for (const task of context.open_tasks ?? []) {
		lines.push(`- open task: ${task.title}${task.status ? ` (${task.status})` : ""}`);
	}
	if (context.state_doc_excerpt) {
		lines.push(
			"",
			"State Doc excerpt (the owner's current priorities):",
			context.state_doc_excerpt.slice(0, MAX_STATE_DOC_CHARS),
		);
	}
	const corrections = (context.recent_corrections ?? context.owner_corrections ?? []).slice(
		0,
		MAX_CORRECTION_EXAMPLES,
	);
	if (corrections.length > 0) {
		lines.push("", "Worked examples (recent owner corrections):");
		for (const c of corrections) {
			const parts = [
				c.sender ? `sender=${c.sender}` : null,
				c.subject ? `subject="${c.subject}"` : null,
				`sender_kind=${c.sender_kind}`,
				`gmail_category=${c.gmail_category}`,
				`system_1_verdict=${formatCorrectionVerdict(c.system_1_verdict)}`,
				`owner_verdict=${formatCorrectionVerdict(c.owner_verdict)}`,
				c.reason ? `reason="${c.reason}"` : null,
			].filter(Boolean);
			lines.push(`- ${parts.join("; ")}`);
		}
	}

	lines.push(
		"",
		`Draft wanted: ${request.want_draft}. Extraction wanted: ${request.want_extraction}.`,
		"",
		"Message:",
		(request.body?.trim() || request.snippet?.trim() || "(empty)").slice(0, MAX_BODY_CHARS),
	);
	return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

function extractJson(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(trimmed.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** Enforce the tone rule a model is likeliest to break. */
export function enforceDraftTone(draft: string): string {
	return draft.replace(/\s*—\s*/g, ", ").replace(/\s*–\s*/g, ", ").trim();
}

export function parseEmailReasonerResponse(
	text: string,
	request: Pick<EmailReasonerRequest, "want_draft" | "want_extraction">,
	model?: string,
): EmailReasonerAssessment | null {
	const parsed = assessmentSchema.safeParse(extractJson(text));
	if (!parsed.success) return null;
	const value = parsed.data;
	const draft = request.want_draft && value.draft_reply?.trim() ? enforceDraftTone(value.draft_reply) : null;
	return {
		category: value.category,
		priority: value.priority,
		confidence: value.confidence,
		rationale: value.rationale,
		needs_reply: value.needs_reply,
		suggested_route: value.suggested_route ?? null,
		draft_reply: draft,
		tasks: request.want_extraction ? value.tasks.slice(0, 5) : [],
		entities: request.want_extraction ? value.entities.slice(0, 10) : [],
		model: model ?? null,
	};
}

export function createLlmEmailReasoner(
	llm: EmailReasonerLlm,
	options: { toneRules?: readonly string[]; model?: string; onError?: (err: unknown) => void } = {},
): EmailReasonerPort {
	const system = buildEmailReasonerSystemPrompt(options.toneRules);
	return {
		async assess(request) {
			try {
				const res = await llm({ system, prompt: buildEmailReasonerPrompt(request), model: options.model });
				return parseEmailReasonerResponse(res.text, request, res.model);
			} catch (err) {
				options.onError?.(err);
				return null;
			}
		},
	};
}

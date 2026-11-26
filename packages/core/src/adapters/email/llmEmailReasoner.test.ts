import { describe, expect, it, vi } from "vitest";
import { extractEmailSignals } from "../../domain/emailSignals.js";
import { assessEmailSystem1 } from "../../domain/emailRubric.js";
import type { EmailReasonerRequest } from "../../ports/emailReasoner.js";
import {
	buildEmailReasonerPrompt,
	createLlmEmailReasoner,
	enforceDraftTone,
	parseEmailReasonerResponse,
} from "./llmEmailReasoner.js";

const signals = extractEmailSignals(
	{ from: "Jim Rice <contact8@example.com>", to: "owner@work.example.com", subject: "Call This Week", snippet: "Are you free?" },
	{ ownerAddresses: ["owner@work.example.com"] },
);

const request: EmailReasonerRequest = {
	account: "work",
	thread_id: "th-1",
	sender: "Jim Rice <contact8@example.com>",
	subject: "Call This Week",
	snippet: "Are you free?",
	body: "Hi Angus, are you free Thursday to talk about the pilot?",
	signals,
	system1: assessEmailSystem1(signals),
	context: {
		sender_profile: { name: "Jim Rice", organization: "Attio", relationship: "partner" },
		open_tasks: [{ title: "Close Attio pilot", status: "In progress" }],
		state_doc_excerpt: "This week: land two pilots.",
	},
	want_draft: true,
	want_extraction: true,
};

describe("llmEmailReasoner", () => {
	it("puts graph, State Doc context, and worked owner correction examples into the prompt", () => {
		const prompt = buildEmailReasonerPrompt({
			...request,
			context: {
				...request.context,
				recent_corrections: [
					{
						sender: "Dana <dana@studio.example>",
						sender_kind: "human",
						gmail_category: "promotions",
						system_1_verdict: "marketing P1 (archive)",
						owner_verdict: { category: "to_respond", priority: 5, route: "attention" },
						reason: "known partner filed in Promotions",
					},
				],
			},
		});
		expect(prompt).toContain("sender is known: Jim Rice, partner, Attio");
		expect(prompt).toContain("open task: Close Attio pilot");
		expect(prompt).toContain("This week: land two pilots.");
		expect(prompt).toContain("a weak prior, often wrong");
		expect(prompt).toContain("Worked examples (recent owner corrections):");
		expect(prompt).toContain(
			'sender_kind=human; gmail_category=promotions; system_1_verdict=marketing P1 (archive); owner_verdict=to_respond P5 (attention); reason="known partner filed in Promotions"',
		);
	});

	it("parses fenced JSON, enforces tone on drafts and drops extraction it did not ask for", () => {
		const text =
			'```json\n{"category":"to_respond","priority":6,"confidence":0.92,"rationale":"asks for a call","needs_reply":true,"suggested_route":"draft_reply","draft_reply":"Hi Jim — Thursday works.","tasks":[{"title":"Book call","confidence":0.9}],"entities":[{"name":"Attio","type":"company"}]}\n```';
		const parsed = parseEmailReasonerResponse(text, request, "gemini-2.5-flash");
		expect(parsed).toMatchObject({ category: "to_respond", priority: 6, draft_reply: "Hi Jim, Thursday works.", model: "gemini-2.5-flash" });
		expect(parsed?.entities[0]?.type).toBe("other");
		expect(parseEmailReasonerResponse(text, { want_draft: false, want_extraction: false })).toMatchObject({
			draft_reply: null,
			tasks: [],
			entities: [],
		});
	});

	it("returns null on garbage or a model error so System 1 and the HITL gate take over", async () => {
		expect(parseEmailReasonerResponse("not json", request)).toBeNull();
		const onError = vi.fn();
		const reasoner = createLlmEmailReasoner(async () => {
			throw new Error("429");
		}, { onError });
		expect(await reasoner.assess(request)).toBeNull();
		expect(onError).toHaveBeenCalled();
	});

	it("strips em and en dashes from drafts", () => {
		expect(enforceDraftTone("Thanks — see you – soon")).toBe("Thanks, see you, soon");
	});
});

import { describe, expect, it } from "vitest";
import { computeEmailPipelineMetrics, type MetricDecision } from "./emailMetrics.js";
import { extractEmailSignals, type EmailSenderOverrideFact } from "./emailSignals.js";
import { assessEmailSystem1 } from "./emailRubric.js";
import { selectThinkingMode } from "./emailRouting.js";

const owner = { ownerAddresses: ["owner@example.com", "owner@work.example.com"] };

const decision = (over: Partial<MetricDecision>): MetricDecision => ({
	account: "personal",
	route: "archive",
	intent_category: "marketing",
	priority: 1,
	thinking_mode: "system_1",
	requires_human: false,
	...over,
});

describe("computeEmailPipelineMetrics override rates", () => {
	it("computes overall, per-route, and per-rubric_version override_rate from modified/rejected statuses", () => {
		const metrics = computeEmailPipelineMetrics(
			[
				decision({ route: "archive", status: "modified", rubric_version: "2026-11-08.2" }),
				decision({ route: "archive", status: "auto_applied", rubric_version: "2026-11-08.2" }),
				decision({
					route: "attention",
					intent_category: "to_respond",
					priority: 6,
					thinking_mode: "system_2",
					requires_human: true,
					status: "rejected",
					rubric_version: "2026-11-08.3",
				}),
				decision({
					route: "attention",
					intent_category: "to_respond",
					priority: 5,
					thinking_mode: "system_2",
					requires_human: true,
					status: "auto_applied",
					rubric_version: "2026-11-08.3",
				}),
				decision({
					route: "review",
					intent_category: "fyi",
					priority: 3,
					requires_human: true,
					status: "approved",
					rubric_version: "2026-11-08.3",
				}),
			],
			{ attentionBudget: 15 },
		);

		expect(metrics.override_rate).toBe(0.4);
		expect(metrics.override_rate_by_route).toMatchObject({
			archive: 0.5,
			attention: 0.5,
			review: 0,
			draft_reply: null,
		});
		expect(metrics.override_rate_by_rubric_version).toEqual({
			"2026-11-08.2": 0.5,
			"2026-11-08.3": 0.333,
		});
	});

	it("returns null override rates when no override status is known", () => {
		const metrics = computeEmailPipelineMetrics([decision({ route: "archive" })], { attentionBudget: 15 });
		expect(metrics.override_rate).toBeNull();
		expect(metrics.override_rate_by_route.archive).toBeNull();
		expect(metrics.override_rate_by_rubric_version).toEqual({});
	});
});

describe("System 1 sender override promotion", () => {
	it("promotes a sender corrected twice to to_respond without low-confidence escalation", () => {
		const overrides: EmailSenderOverrideFact[] = [
			{ sender: "Dana <dana@studio.example>", intent_category: "to_respond", priority: 5, status: "modified" },
			{ sender: "dana@studio.example", route: "attention", status: "modified" },
		];
		const signals = extractEmailSignals(
			{ from: "Dana <dana@studio.example>", to: "owner@work.example.com", subject: "Quick update" },
			{ ...owner, senderOverrides: overrides },
		);
		const system1 = assessEmailSystem1(signals);

		expect(system1).toMatchObject({
			category: "to_respond",
			priority: 5,
			confidence: 0.95,
		});
		expect(system1.reasons).toContain("learned_sender_override:to_respond");
	});

	it("classifies a sender corrected twice to archive deterministically in System 1 without escalating to System 2", () => {
		const overrides: EmailSenderOverrideFact[] = [
			{ sender: "Pitcher <pitch@vendor.example>", route: "archive", status: "modified" },
			{ sender: "pitch@vendor.example", intent_category: "marketing", priority: 1, status: "rejected" },
		];
		const signals = extractEmailSignals(
			{
				from: "Pitcher <pitch@vendor.example>",
				to: "owner@work.example.com",
				subject: "Checking in on your roadmap",
				snippet: "Can you spare 10 minutes this week?",
			},
			{ ...owner, senderOverrides: overrides },
		);
		const system1 = assessEmailSystem1(signals);

		expect(system1).toMatchObject({
			category: "marketing",
			priority: 1,
			confidence: 0.95,
		});
		expect(system1.reasons).toContain("learned_sender_override:archive");
		expect(selectThinkingMode(signals, system1).mode).toBe("system_1");
	});

	it("does not promote a sender with only one override or conflicting overrides", () => {
		const single = extractEmailSignals(
			{ from: "Sam <sam@example.com>", to: "owner@work.example.com", subject: "Hello" },
			{ ...owner, senderOverrides: [{ sender: "sam@example.com", route: "archive", status: "modified" }] },
		);
		expect(assessEmailSystem1(single).confidence).toBeLessThan(0.7);

		const conflicting = extractEmailSignals(
			{ from: "Sam <sam@example.com>", to: "owner@work.example.com", subject: "Hello" },
			{
				...owner,
				senderOverrides: [
					{ sender: "sam@example.com", route: "archive", status: "modified" },
					{ sender: "sam@example.com", intent_category: "to_respond", priority: 5, status: "modified" },
				],
			},
		);
		expect(assessEmailSystem1(conflicting).confidence).toBeLessThan(0.7);
	});
});

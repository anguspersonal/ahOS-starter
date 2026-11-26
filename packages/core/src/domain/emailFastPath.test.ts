import { describe, expect, it } from "vitest";
import {
	buildHop1FanOutQuestions,
	buildHop2ResolutionQuestions,
	buildWorthAnalysisQuestion,
	decideFastPath,
	decideHop1FanOut,
	decideHop2Resolution,
} from "./emailFastPath.js";
import { EMAIL_GOLDEN_EXAMPLES } from "./emailGoldenExamples.js";
import { extractEmailSignals, resolvePersonRelationship } from "./emailSignals.js";

const owner = ["owner@example.com", "owner@work.example.com"];
const result = (yes: number, id = "worth_analysis") => ({
	id,
	kind: "noul" as const,
	choice: yes >= 0.5 ? "yes" : "no",
	confidence: Math.max(yes, 1 - yes),
	distribution: { yes, no: 1 - yes },
	model: "m",
	latency_ms: 1,
});

describe("email fast path", () => {
	it("puts the evidence a screener needs into one yes/no question", () => {
		const g = EMAIL_GOLDEN_EXAMPLES.find((e) => e.id.startsWith("g1"))!;
		const signals = extractEmailSignals(g.envelope, { ownerAddresses: owner, ...g.facts });
		const q = buildWorthAnalysisQuestion({ ...g.envelope, text: g.envelope.body, signals });
		expect(q.kind).toBe("noul");
		expect(q.prompt).toContain("Angus has emailed this sender before: no");
		expect(q.prompt).toContain("Subject: Angus, not another");
		expect(q.prompt).toContain("cold sales pitches");
		expect(q.prompt).toContain("money spent or billed, receipts, invoices");
	});

	it("skips analysis only on a confident no, and fails open with no judge", () => {
		expect(decideFastPath(result(0.2))).toMatchObject({ analyse: false, reason: "judge_confident_no" });
		expect(decideFastPath(result(0.35))).toMatchObject({ analyse: true, reason: "judge_unsure" });
		expect(decideFastPath(result(0.8))).toMatchObject({ analyse: true, reason: "judge_yes" });
		expect(decideFastPath(null)).toMatchObject({ analyse: true, pYes: null, reason: "no_judge" });
	});

	it("keeps every golden example labelled for the fast path", () => {
		expect(EMAIL_GOLDEN_EXAMPLES.map((g) => g.id)).toContain("g3-meta-ads-receipt");
		for (const g of EMAIL_GOLDEN_EXAMPLES) expect(typeof g.expect.worth_analysis).toBe("boolean");
	});

	it("builds Hop 1 fan-out + context router and Hop 2 resolution for Nick coaching", () => {
		const g2 = EMAIL_GOLDEN_EXAMPLES.find((e) => e.id === "g2-nick-coaching-confirmation")!;
		const signals = extractEmailSignals(g2.envelope, { ownerAddresses: owner, ...g2.facts });
		const fpInput = { ...g2.envelope, text: g2.envelope.body, signals };
		const h1Questions = buildHop1FanOutQuestions(fpInput);
		expect(h1Questions.map((q) => q.id)).toEqual([
			"needs_reply",
			"has_owner_commitment",
			"has_fact_to_persist",
			"probe_calendar",
			"probe_tasks",
			"probe_drive",
			"probe_graph_artifacts",
			"probe_unverifiable_external",
		]);

		const hop1 = decideHop1FanOut(
			{
				needs_reply: result(0.08, "needs_reply"),
				has_owner_commitment: result(0.86, "has_owner_commitment"),
				has_fact_to_persist: result(0.91, "has_fact_to_persist"),
				probe_calendar: result(0.95, "probe_calendar"),
				probe_tasks: result(0.2, "probe_tasks"),
				probe_drive: result(0.05, "probe_drive"),
				probe_graph_artifacts: result(0.1, "probe_graph_artifacts"),
				probe_unverifiable_external: result(0.02, "probe_unverifiable_external"),
			},
			signals,
		);
		expect(hop1).toMatchObject({
			needs_reply: false,
			has_owner_commitment: true,
			has_fact_to_persist: true,
			is_new_contact: false,
			needs_contact_email_backfill: true,
			probes: ["calendar"],
			needs_hop2: true,
		});

		const h2Questions = buildHop2ResolutionQuestions(fpInput, g2.probe_evidence!);
		expect(h2Questions.map((q) => q.id)).toEqual([
			"commitment_already_satisfied",
			"adds_info_to_existing_item",
			"needs_owner_escalation",
		]);
		expect(h2Questions[0].state).toContain("Debate Training - Nick");

		const hop2 = decideHop2Resolution(hop1, {
			commitment_already_satisfied: result(0.93, "commitment_already_satisfied"),
			adds_info_to_existing_item: result(0.12, "adds_info_to_existing_item"),
			needs_owner_escalation: result(0.09, "needs_owner_escalation"),
		});
		expect(hop2).toMatchObject({
			commitment_already_satisfied: true,
			adds_info_to_existing_item: false,
			needs_owner_escalation: false,
			route: "archive",
		});
	});

	it("resolves relationship from people tags/role and flags is_new_contact when no people row exists", () => {
		expect(resolvePersonRelationship({ relationship: null, tags: ["family", "dad"], role: null })).toBe("dad");
		expect(resolvePersonRelationship({ relationship: null, tags: [], role: "Coaching Client" })).toBe(
			"Coaching Client",
		);
		expect(resolvePersonRelationship({ relationship: "advisor", tags: ["family"], role: "CEO" })).toBe("advisor");

		const g2 = EMAIL_GOLDEN_EXAMPLES.find((e) => e.id === "g2-nick-coaching-confirmation")!;
		const unlinkedSignals = extractEmailSignals(g2.envelope, {
			ownerAddresses: owner,
			knownContact: false,
			ownerHasWritten: true,
		});
		const hop1Unlinked = decideHop1FanOut(null, unlinkedSignals);
		expect(hop1Unlinked.is_new_contact).toBe(true);
		expect(hop1Unlinked.needs_contact_email_backfill).toBe(false);
	});
});

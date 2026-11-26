import { describe, expect, it, vi } from "vitest";
import { computeEmailPipelineMetrics } from "../../domain/emailMetrics.js";
import { defineAction } from "../../actions/defineAction.js";
import { z } from "zod";
import { createGmailTriageCadence, parseGmailTriageMode, runGmailTriageSweep } from "./gmailTriageCadence.js";

function registryWith(run: (input: Record<string, unknown>) => Promise<unknown>) {
	const action = defineAction({
		id: "gmail_priority_triage",
		domain: "integrations",
		description: "test double",
		schema: z.object({}).passthrough(),
		run: async (input) => run(input as Record<string, unknown>),
	});
	return { get: (id: string) => (id === "gmail_priority_triage" ? action : undefined) };
}

const output = {
	mode: "shadow",
	rubric_version: "v",
	skipped_already_decided: 3,
	promoted_artifact_count: 1,
	errors: [],
	metrics: computeEmailPipelineMetrics(
		[{ account: "personal", route: "attention", intent_category: "to_respond", priority: 6, thinking_mode: "system_2", requires_human: true }],
		{ mailboxBefore: { personal: { inbox: 40, unread: 30 } }, attentionBudget: 15 },
	),
};

describe("gmail triage cadence (ADR-118)", () => {
	it("runs the registry action across both mailboxes in shadow mode by default and flattens the metrics", async () => {
		const run = vi.fn(async () => output);
		const result = await runGmailTriageSweep({ userId: "u1", registry: registryWith(run), auditSink: () => {} });

		expect(run.mock.calls[0][0]).toMatchObject({ account: "all", mode: "shadow", include_decisions: false, attention_budget: 15 });
		expect(result.error).toBeUndefined();
		expect(result.counts).toMatchObject({ inbox_before: 40, unread_before: 30, processed: 1, needs_attention: 1, within_budget: true, skipped_already_decided: 3 });
	});

	it("returns a failed sweep instead of throwing, and the cadence surfaces it as a failed run", async () => {
		const registry = registryWith(async () => {
			throw new Error("gmail 401");
		});
		const result = await runGmailTriageSweep({ userId: "u1", registry, auditSink: () => {} });
		expect(result).toMatchObject({ output: null, counts: {} });
		expect(result.error).toContain("gmail 401");

		const cadence = createGmailTriageCadence({ userId: "u1", registry, auditSink: () => {} });
		expect(cadence).toMatchObject({ name: "gmail_automations", connector: "gmail_triage", intervalMs: 3_600_000 });
		await expect(cadence.run()).rejects.toThrow("gmail 401");
	});

	it("only accepts label or act as a non-shadow mode", () => {
		expect(parseGmailTriageMode(undefined)).toBe("shadow");
		expect(parseGmailTriageMode("ACT")).toBe("act");
		expect(parseGmailTriageMode("yolo")).toBe("shadow");
	});
});

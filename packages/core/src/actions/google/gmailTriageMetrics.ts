/**
 * @ahkms/core/actions/google - gmail_triage_metrics (ADR-118 §9, ADR-110 §1)
 *
 * Read-only daily series for the email pipeline dashboard: inbox and unread (from the
 * retained daily mailbox snapshot), and processed, new, needs-attention against the
 * budget, routes, thinking modes and owner corrections (derived from the decision log).
 */

import { z } from "zod";
import {
	buildEmailMetricsSeries,
	DEFAULT_EMAIL_METRICS_TIME_ZONE,
	type EmailMetricsSeries,
} from "../../domain/emailMetricsSeries.js";
import { DEFAULT_EMAIL_HITL_POLICY } from "../../domain/emailRouting.js";
import type { GmailTriageMetricsPort } from "../../ports/emailMetrics.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const gmailTriageMetricsInputSchema = z.object({
	days: z
		.number()
		.int()
		.min(1)
		.max(90)
		.optional()
		.default(14)
		.describe("How many days to return, ending today. Defaults to 14."),
	attention_budget: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(DEFAULT_EMAIL_HITL_POLICY.dailyAttentionBudget)
		.describe("The daily attention target each day is judged against. Defaults to 15."),
	time_zone: z
		.string()
		.min(1)
		.optional()
		.default(DEFAULT_EMAIL_METRICS_TIME_ZONE)
		.describe("IANA time zone whose midnight cuts the days. Defaults to Europe/London."),
});

export type GmailTriageMetricsInput = z.infer<typeof gmailTriageMetricsInputSchema>;
export type GmailTriageMetricsOutput = EmailMetricsSeries & { window_days: number; generated_at: string };

function isValidTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export function createGmailTriageMetricsAction(
	port: GmailTriageMetricsPort,
	options: { now?: () => Date } = {},
): ActionDefinition<typeof gmailTriageMetricsInputSchema, GmailTriageMetricsOutput> {
	return defineAction({
		id: "gmail_triage_metrics",
		domain: "integrations",
		description:
			"Daily email pipeline metrics for the dashboard: inbox and unread threads, processed, new, needs-attention against the 15-a-day budget, review, drafts, tasks, routes, System 1 versus System 2, and owner corrections. Read-only.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		schema: gmailTriageMetricsInputSchema,
		run: async (input, ctx) => {
			const now = options.now?.() ?? new Date();
			const days = input.days ?? 14;
			const timeZone = input.time_zone ?? DEFAULT_EMAIL_METRICS_TIME_ZONE;
			if (!isValidTimeZone(timeZone)) {
				throw new Error(`gmail_triage_metrics: '${timeZone}' is not an IANA time zone (e.g. Europe/London).`);
			}
			// One extra day of margin: local midnight can sit up to a day either side of UTC's.
			const sinceIso = new Date(now.getTime() - (days + 1) * 24 * 60 * 60 * 1000).toISOString();
			const [decisions, snapshots] = await Promise.all([
				port.listDecisionFacts(sinceIso, ctx?.userId),
				port.listMailboxSnapshots(sinceIso, ctx?.userId),
			]);
			const series = buildEmailMetricsSeries(decisions, snapshots, {
				now,
				days,
				attentionBudget: input.attention_budget ?? DEFAULT_EMAIL_HITL_POLICY.dailyAttentionBudget,
				timeZone,
			});
			return { ...series, window_days: days, generated_at: now.toISOString() };
		},
	});
}

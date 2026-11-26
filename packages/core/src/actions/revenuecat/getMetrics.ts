import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { RevenueCatMetric, RevenueCatMetrics, RevenueCatPort } from "../../ports/revenuecat.js";
import {
	formatRevenueCatHeader,
	type RevenueCatResultStamp,
	stampForRevenueCat,
} from "../../domain/revenuecat/contract.js";

export const revenuecatGetMetricsInput = {
	project_id: z
		.string()
		.min(1)
		.describe(
			"RevenueCat project id (v2 API, Production project) — find it in RevenueCat → Project settings → API keys. No default: the caller names which project every time.",
		),
	purpose: z
		.enum(["reporting", "debugging"])
		.optional()
		.describe(
			"Read purpose. Defaults to 'reporting'. Set to 'debugging' for declared debugging reads (#970 exception); the returned stamp will flag the output accordingly.",
		),
} as const;

export const revenuecatGetMetricsSchema = z.object(revenuecatGetMetricsInput);
export type RevenueCatGetMetricsInput = z.infer<typeof revenuecatGetMetricsSchema>;

export type RevenueCatGetMetricsOutput = {
	metrics: RevenueCatMetrics;
	stamp: RevenueCatResultStamp;
	text: string;
};

function line(label: string, metric: RevenueCatMetric | null): string {
	if (!metric) return `${label}: (not returned by RevenueCat for this project)`;
	return `${label}: ${metric.value ?? "(no value)"}`;
}

/**
 * Creates the `revenuecat_get_metrics` core action over a `RevenueCatPort` (ADR-105, #1536).
 */
export function createRevenueCatGetMetricsAction(
	port: RevenueCatPort,
): ActionDefinition<typeof revenuecatGetMetricsSchema, RevenueCatGetMetricsOutput> {
	return defineAction({
		id: "revenuecat_get_metrics",
		description:
			"Read-only RevenueCat scorecard metrics (v2 API): active subscriptions, active trials and MRR for one project. Requires REVENUECAT_API_KEY server-side; the key is never returned to the caller. Scoped to these three cells rather than a general passthrough — nothing else needs RevenueCat today. Full notes: docs/guides/tools/revenuecat_get_metrics.md",
		schema: revenuecatGetMetricsSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (args) => {
			const metrics = await port.getMetrics(args.project_id);

			const purpose = args.purpose ?? "reporting";
			const stamp = stampForRevenueCat(args.project_id, purpose);
			const header = formatRevenueCatHeader(stamp);

			const body = [
				`RevenueCat metrics for project ${args.project_id}:`,
				line("Active subscriptions", metrics.activeSubscriptions),
				line("Active trials", metrics.activeTrials),
				line("MRR", metrics.mrr),
			].join("\n");

			const text = `${header}\n\n${body}`;

			return { metrics, stamp, text };
		},
		formatMcp: (output) => output.text,
	});
}

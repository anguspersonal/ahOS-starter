import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	assertRatifiedMetric,
	formatRevenueCatHeader,
	REVENUECAT_TEST_ACCOUNT_CONTRACT,
	stampForRevenueCat,
} from "../../domain/revenuecat/contract.js";
import type { RevenueCatPort } from "../../ports/revenuecat.js";
import { createRevenueCatGetMetricsAction, revenuecatGetMetricsInput } from "./getMetrics.js";

function makePort(overrides?: Partial<RevenueCatPort>): RevenueCatPort {
	return {
		getMetrics: vi.fn(async (_projectId: string) => ({
			activeSubscriptions: { id: "active_subscriptions", name: "Active Subscriptions", value: 42 },
			activeTrials: { id: "active_trials", name: "Active Trials", value: 7 },
			mrr: { id: "mrr", name: "MRR", value: 420.5 },
		})),
		...overrides,
	};
}

describe("revenuecat_get_metrics action contract (R11)", () => {
	it("preserves legacy id, description, annotations, and JSON schema", () => {
		const action = createRevenueCatGetMetricsAction(makePort());

		expect(action.id).toBe("revenuecat_get_metrics");
		expect(action.description).toBe(
			"Read-only RevenueCat scorecard metrics (v2 API): active subscriptions, active trials and MRR for one project. Requires REVENUECAT_API_KEY server-side; the key is never returned to the caller. Scoped to these three cells rather than a general passthrough — nothing else needs RevenueCat today. Full notes: docs/guides/tools/revenuecat_get_metrics.md",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				project_id: {
					type: "string",
					minLength: 1,
					description:
						"RevenueCat project id (v2 API, Production project) — find it in RevenueCat → Project settings → API keys. No default: the caller names which project every time.",
				},
				purpose: {
					type: "string",
					enum: ["reporting", "debugging"],
					description:
						"Read purpose. Defaults to 'reporting'. Set to 'debugging' for declared debugging reads (#970 exception); the returned stamp will flag the output accordingly.",
				},
			},
			required: ["project_id"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(revenuecatGetMetricsInput)));
	});
});

describe("revenuecat contract — test account definitions (#742)", () => {
	it("records that sandbox is excluded but internal accounts are included", () => {
		expect(REVENUECAT_TEST_ACCOUNT_CONTRACT.sandboxExcluded).toBe(true);
		expect(REVENUECAT_TEST_ACCOUNT_CONTRACT.internalAccountsExcluded).toBe(false);
	});

	it("identifies downstream filterable path in PostHog", () => {
		expect(REVENUECAT_TEST_ACCOUNT_CONTRACT.downstreamFilterablePath).toContain("$posthogUserId");
	});

	it("restricts ratified scorecard metrics to active_subscriptions, active_trials, mrr", () => {
		const metricIds = REVENUECAT_TEST_ACCOUNT_CONTRACT.ratifiedMetrics.map((m) => m.id);
		expect(metricIds).toEqual(["active_subscriptions", "active_trials", "mrr"]);
	});
});

describe("revenuecat contract — false friend protection", () => {
	it("allows ratified metrics", () => {
		expect(() => assertRatifiedMetric("active_subscriptions")).not.toThrow();
		expect(() => assertRatifiedMetric("active_trials")).not.toThrow();
		expect(() => assertRatifiedMetric("mrr")).not.toThrow();
	});

	it("rejects 'new_customers' with a warning explaining it is an install-scale false friend", () => {
		expect(() => assertRatifiedMetric("new_customers")).toThrow(
			/false friend.*app_user_id mintings/,
		);
	});

	it("rejects 'active_users' with a warning explaining it is a 28-day false friend", () => {
		expect(() => assertRatifiedMetric("active_users")).toThrow(
			/false friend.*28-day app_user_id/,
		);
	});

	it("rejects unknown metrics outside the ratified set", () => {
		expect(() => assertRatifiedMetric("random_metric")).toThrow(
			/not in the ratified RevenueCat scorecard set/,
		);
	});
});

describe("revenuecat contract — stampForRevenueCat and header formatting", () => {
	it("mints stamp with connection, project, policy, basis and timestamp", () => {
		const fixedDate = new Date("2026-09-25T12:00:00.000Z");
		const stamp = stampForRevenueCat("proje92a264b", "reporting", fixedDate);

		expect(stamp).toEqual({
			connection: "revenuecat:proje92a264b",
			project_id: "proje92a264b",
			filter_policy: "sandbox_excluded_internal_included",
			pulled_at: "2026-09-25T12:00:00.000Z",
			basis: "Sandbox/TestFlight excluded; internal & F&F accounts included (unfiltered by RC).",
			purpose: "reporting",
		});
	});

	it("formats header cleanly for reporting reads", () => {
		const fixedDate = new Date("2026-09-25T12:00:00.000Z");
		const stamp = stampForRevenueCat("proje92a264b", "reporting", fixedDate);
		const header = formatRevenueCatHeader(stamp);

		expect(header).toContain("connection:    revenuecat:proje92a264b");
		expect(header).toContain("filter policy: sandbox_excluded_internal_included");
		expect(header).toContain("basis:         Sandbox/TestFlight excluded; internal & F&F accounts included");
		expect(header).not.toContain("DEBUG READ");
	});

	it("flags header as DEBUG READ when purpose is debugging (#970 exception)", () => {
		const fixedDate = new Date("2026-09-25T12:00:00.000Z");
		const stamp = stampForRevenueCat("proje92a264b", "debugging", fixedDate);
		const header = formatRevenueCatHeader(stamp);

		expect(header).toContain("filter policy: sandbox_excluded_internal_included — DEBUG READ");
		expect(header).toContain("purpose:       debugging");
	});
});

describe("revenuecat_get_metrics action behaviour", () => {
	it("defaults purpose to reporting and renders the provenance header before any metric number", async () => {
		const action = createRevenueCatGetMetricsAction(makePort());
		const out = await action.run({ project_id: "proje92a264b" }, { userId: "u1", caller: "test", requestId: "req-1" });
		const text = action.formatMcp!(out);

		expect(out.stamp.purpose).toBe("reporting");
		expect(text).toContain("connection:    revenuecat:proje92a264b");
		expect(text).toContain("filter policy: sandbox_excluded_internal_included");
		expect(text).not.toContain("DEBUG READ");
		expect(text.indexOf("connection:    revenuecat:proje92a264b")).toBeLessThan(text.indexOf("42"));
		expect(text).toContain("Active subscriptions: 42");
	});

	it("stamps debug reads when purpose: debugging is passed", async () => {
		const action = createRevenueCatGetMetricsAction(makePort());
		const out = await action.run(
			{ project_id: "proje92a264b", purpose: "debugging" },
			{ userId: "u1", caller: "test", requestId: "req-1" },
		);
		const text = action.formatMcp!(out);

		expect(text).toContain("DEBUG READ");
		expect(text).toContain("purpose:       debugging");
	});

	it("prints '(not returned by RevenueCat for this project)' when a metric is null", async () => {
		const action = createRevenueCatGetMetricsAction(
			makePort({
				getMetrics: vi.fn(async () => ({
					activeSubscriptions: { id: "active_subscriptions", name: "Active Subscriptions", value: 10 },
					activeTrials: null,
					mrr: null,
				})),
			}),
		);
		const out = await action.run({ project_id: "proje92a264b" }, { userId: "u1", caller: "test", requestId: "req-1" });
		const text = action.formatMcp!(out);

		expect(text).toContain("Active subscriptions: 10");
		expect(text).toContain("Active trials: (not returned by RevenueCat for this project)");
		expect(text).toContain("MRR: (not returned by RevenueCat for this project)");
	});

	it("never includes the API key in output or errors", async () => {
		const action = createRevenueCatGetMetricsAction(makePort());
		const out = await action.run({ project_id: "proje92a264b" }, { userId: "u1", caller: "test", requestId: "req-1" });
		expect(action.formatMcp!(out)).not.toContain("sk_");
	});
});

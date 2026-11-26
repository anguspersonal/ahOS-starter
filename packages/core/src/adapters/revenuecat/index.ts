import type {
	RevenueCatMetric,
	RevenueCatMetrics,
	RevenueCatPort,
} from "../../ports/revenuecat.js";

export type { RevenueCatMetric, RevenueCatMetrics, RevenueCatPort };

// RevenueCat metrics (#647), originally built for the Work weekly scorecard
// (since migrated to example-org/ops / work-mcp in #1365): extracts active
// subscriptions, active trials and MRR without a per-environment RevenueCat key.
// Read-only by construction — this client issues GETs only, there is no write
// helper anywhere in this file — against RevenueCat's v2 "project overview
// metrics" endpoint, GET /v2/projects/{project_id}/metrics/overview, whose
// response shape (a `metrics` array of {id, name, value, ...}) is documented at
// https://www.revenuecat.com/docs/api-v2/charts-and-metrics (verified against
// that page 2026-09-24, round-1 QA fix; still unverified against a live
// account — see PR Risks).
//
// A SCOPED tool over a generic revenuecat_call_tool passthrough, per the issue's
// own preference (#647, comment 2026-08-18): RevenueCat's v2 metrics response
// carries several figures (new customers, active users, churn, ...); this client
// extracts exactly the three the scorecard names rather than exposing the whole
// project surface, which is a tighter permission boundary than a passthrough
// would give — nothing else needs RevenueCat today, and widening this is a
// deliberate code change rather than a caller's argument choice.

const REVENUECAT_API_BASE = "https://api.revenuecat.com/v2";

type RevenueCatMetricsResponse = {
	metrics?: unknown[];
	message?: string;
};

function pickMetric(items: unknown[], id: string): RevenueCatMetric | null {
	const item = items.find(
		(i): i is { id: string; name?: string; value?: number | null } =>
			typeof i === "object" && i !== null && (i as { id?: unknown }).id === id,
	);
	if (!item) return null;
	return { id: item.id, name: item.name ?? item.id, value: item.value ?? null };
}

/**
 * GET the overview metrics for one RevenueCat project, and pull out exactly the
 * scorecard's three cells: active subscriptions, active trials, MRR. Any of the
 * three coming back `null` means RevenueCat's response simply did not include
 * that metric id (a project/plan variation) — that is reported as-is rather than
 * treated as an error, so a partial answer is still useful.
 */
export async function getRevenueCatMetrics(
	projectId: string,
	getApiKey: () => Promise<string>,
): Promise<RevenueCatMetrics> {
	const key = await getApiKey();

	const res = await fetch(
		`${REVENUECAT_API_BASE}/projects/${encodeURIComponent(projectId)}/metrics/overview`,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				Accept: "application/json",
			},
		},
	);

	const bodyText = await res.text().catch(() => "");
	let parsed: RevenueCatMetricsResponse = {};
	try {
		parsed = bodyText ? (JSON.parse(bodyText) as RevenueCatMetricsResponse) : {};
	} catch {
		// Non-JSON body — fall through and surface the raw text below.
	}

	if (!res.ok) {
		throw new Error(
			`RevenueCat API error ${res.status}: ${parsed.message ?? bodyText.slice(0, 600) ?? res.statusText}`,
		);
	}

	const items = Array.isArray(parsed.metrics) ? parsed.metrics : [];
	return {
		activeSubscriptions: pickMetric(items, "active_subscriptions"),
		activeTrials: pickMetric(items, "active_trials"),
		mrr: pickMetric(items, "mrr"),
	};
}

/**
 * Creates a RevenueCatPort adapter backed by RevenueCat's v2 REST API using lazy API key resolution.
 */
export function createRevenueCatAdapter(getApiKey: () => Promise<string>): RevenueCatPort {
	return {
		getMetrics(projectId: string) {
			return getRevenueCatMetrics(projectId, getApiKey);
		},
	};
}

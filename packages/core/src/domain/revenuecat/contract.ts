/**
 * RevenueCat metrics contract (#742, ADR-060, grill resolution 2026-09-25).
 *
 * Source of truth for RevenueCat metrics semantics, test-account handling, and false-friend protection:
 *
 * 1. Test Account Handling:
 *    - Sandbox / TestFlight transactions are excluded automatically by RevenueCat's v2 API
 *      in the Production project (proje92a264b).
 *    - Internal, friends-and-family (F&F), and contractor accounts are NOT filterable within
 *      RevenueCat itself (RevenueCat v2 API and Charts cannot filter on custom subscriber attributes,
 *      and there is no per-customer exclusion list).
 *    - Therefore, real-external subscriber metrics (paying_users, active_trials, mrr) are
 *      always subject to internal-account caveats when quoted directly from RevenueCat.
 *    - The filterable path is downstream: the mobile app sets the reserved $posthogUserId
 *      subscriber attribute to the Firebase UID (canonical identity), so RC-forwarded revenue events
 *      in PostHog attach to distinct_id and are excluded by PostHog's canonical filter cohorts (168929 etc.).
 *
 * 2. False Friend Protections (Registry vs Vendor Mapping):
 *    - RevenueCat dashboard labels "New Customers" and "Active Users" are FALSE FRIENDS.
 *      They count raw app_user_id mintings (app openers / installs scale) across a 28-day window,
 *      including anonymous IDs ($RCAnonymousID) and internal accounts.
 *      They are NOT new_users or weekly_active_users, and are emphatically NOT paying subscribers.
 *    - This contract restricts RevenueCat metrics reads to the three ratified scorecard cells:
 *      - `active_subscriptions` -> `paying_users` (with internal-accounts caveat)
 *      - `active_trials` -> `active_trials` (with internal-accounts caveat)
 *      - `mrr` -> `mrr` (with internal-accounts caveat)
 *    - `assertRatifiedMetric` below is the guard that refuses a false-friend vendor
 *      quantity by id. As of this writing `revenuecat_get_metrics` (tools/revenuecat.ts)
 *      does not take a caller-supplied metric id — it always returns exactly the three
 *      ratified cells above, so there is no live call path today for a caller to name
 *      `new_customers` or `active_users` through this tool in the first place. The guard
 *      is exported and tested so that it is ready the moment a metric-id parameter is
 *      added to that handler, but it is not yet invoked from it.
 *
 * 3. Provenance Stamp:
 *    Every RevenueCat read produces a ResultStamp declaring:
 *    - connection: `revenuecat:<projectId>`
 *    - project_id
 *    - filter_policy: "sandbox_excluded_internal_included"
 *    - pulled_at timestamp
 *    - test account basis caveats
 */

export const REVENUECAT_TEST_ACCOUNT_CONTRACT = {
	sandboxExcluded: true,
	internalAccountsExcluded: false,
	downstreamFilterablePath: "$posthogUserId subscriber attribute forwarded to PostHog",
	ratifiedMetrics: [
		{ id: "active_subscriptions", registryMetric: "paying_users", unit: "paying subscriber" },
		{ id: "active_trials", registryMetric: "active_trials", unit: "trial subscriber" },
		{ id: "mrr", registryMetric: "mrr", unit: "USD / month" },
	],
	falseFriends: [
		{
			vendorMetric: "new_customers",
			warning: "RC 'New Customers' counts 28-day app_user_id mintings (app-install scale), NOT new_users or subscribers.",
		},
		{
			vendorMetric: "active_users",
			warning: "RC 'Active Users' counts 28-day app_user_id mintings, NOT weekly_active_users or subscribers.",
		},
	],
} as const;

export const REVENUECAT_FILTER_POLICY = "sandbox_excluded_internal_included" as const;
export type RevenueCatFilterPolicy = typeof REVENUECAT_FILTER_POLICY;

export type RevenueCatResultStamp = {
	connection: string;
	project_id: string;
	filter_policy: RevenueCatFilterPolicy;
	pulled_at: string;
	basis: string;
	purpose?: "reporting" | "debugging";
};

/**
 * Mint the provenance stamp for a RevenueCat metrics read.
 */
export function stampForRevenueCat(
	projectId: string,
	purpose: "reporting" | "debugging" = "reporting",
	now: Date = new Date(),
): RevenueCatResultStamp {
	return {
		connection: `revenuecat:${projectId}`,
		project_id: projectId,
		filter_policy: REVENUECAT_FILTER_POLICY,
		pulled_at: now.toISOString(),
		basis: "Sandbox/TestFlight excluded; internal & F&F accounts included (unfiltered by RC).",
		purpose,
	};
}

/**
 * Format the provenance stamp header to lead any RevenueCat metric output.
 */
export function formatRevenueCatHeader(stamp: RevenueCatResultStamp): string {
	const lines = [
		`connection:    ${stamp.connection}`,
		`project:       ${stamp.project_id}`,
		`filter policy: ${stamp.filter_policy}${stamp.purpose === "debugging" ? " — DEBUG READ" : ""}`,
		`basis:         ${stamp.basis}`,
	];
	if (stamp.purpose === "debugging") {
		lines.push("purpose:       debugging");
	}
	lines.push(`pulled at:     ${stamp.pulled_at}`);
	return lines.join("\n");
}

/**
 * Assert that a requested metric id is in the ratified scorecard set and not a false friend.
 */
export function assertRatifiedMetric(metricId: string): void {
	const falseFriend = REVENUECAT_TEST_ACCOUNT_CONTRACT.falseFriends.find(
		(f) => f.vendorMetric === metricId,
	);
	if (falseFriend) {
		throw new Error(
			`Metric '${metricId}' is a RevenueCat false friend: ${falseFriend.warning} Use PostHog or the ratified metrics.`,
		);
	}
	const isRatified = REVENUECAT_TEST_ACCOUNT_CONTRACT.ratifiedMetrics.some(
		(m) => m.id === metricId,
	);
	if (!isRatified) {
		throw new Error(
			`Metric '${metricId}' is not in the ratified RevenueCat scorecard set (active_subscriptions, active_trials, mrr).`,
		);
	}
}

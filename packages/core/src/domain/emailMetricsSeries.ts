/**
 * @ahkms/core/domain - emailMetricsSeries.ts
 *
 * The email pipeline's dashboard series (ADR-118 §9, placed per ADR-110 §1):
 * - flows (processed, new, needs attention, routes, thinking modes, corrections) are
 *   DERIVED AT READ from the decision rows in `system_decisions`, so attended runs,
 *   scheduled runs and the owner's later corrections all count, with no second copy;
 * - stocks (inbox and unread thread counts) are RETAINED as one metrics artifact per
 *   day, because Gmail keeps no history of them.
 *
 * Pure. Isomorphic: zero Node imports (Intl only).
 */

import { EMAIL_ROUTES, INBOX_ROUTES, type EmailRoute } from "./emailRouting.js";
import type { MailboxCounts } from "./emailMetrics.js";

/** Days are cut at the owner's local midnight, not UTC's. */
export const DEFAULT_EMAIL_METRICS_TIME_ZONE = "Europe/London";

/** The content subtype and dedup key prefix of the daily mailbox snapshot artifact. */
export const EMAIL_MAILBOX_SNAPSHOT_SUBTYPE = "email_mailbox_daily";

export function emailMailboxSnapshotDedupKey(date: string): string {
	return `${EMAIL_MAILBOX_SNAPSHOT_SUBTYPE}:${date}`;
}

/** One decision row as the series reads it (a narrow projection of `system_decisions`). */
export interface EmailDecisionFact {
	created_at: string;
	/** `system_decisions.status`: `pending` (review), `auto_applied`, or an owner outcome. */
	status?: string | null;
	thread_id?: string | null;
	account?: string | null;
	route?: string | null;
	natural_route?: string | null;
	thinking_mode?: string | null;
	applied?: boolean | null;
	over_budget?: boolean | null;
	draft_id?: string | null;
	gmail_category_contradiction?: boolean | null;
	tasks_extracted?: number | null;
	entities_extracted?: number | null;
	created_task_count?: number | null;
	rubric_version?: string | null;
	sender?: string | null;
	sender_kind?: string | null;
	gmail_category?: string | null;
	intent_category?: string | null;
	priority?: number | null;
}

/** One stored mailbox snapshot: the latest counts observed on a day, per account. */
export interface EmailMailboxSnapshot {
	date: string;
	observed_at: string;
	accounts: Record<string, MailboxCounts>;
}

export interface EmailMetricsDay {
	date: string;
	/** End-of-day (latest observed) inbox and unread threads, summed over accounts; null when unobserved. */
	inbox: number | null;
	unread: number | null;
	processed: number;
	/** Threads judged for the first time in the window on this day. */
	new: number;
	/** Routed to the owner (attention + draft_reply + review): the success measure. */
	needs_attention: number;
	within_budget: boolean;
	attention_over_budget: number;
	review: number;
	/** Review items the owner has since resolved (any non-pending status on a review row). */
	review_resolved: number;
	drafts_created: number;
	tasks_extracted: number;
	tasks_created: number;
	entities_extracted: number;
	auto_applied: number;
	leaves_inbox: number;
	system_1: number;
	system_2: number;
	gmail_category_contradictions: number;
	/** Decisions the owner changed or rejected. */
	overrides: number;
	by_route: Record<EmailRoute, number>;
	by_account: Record<string, { processed: number; needs_attention: number; inbox: number | null; unread: number | null }>;
}

export interface EmailMetricsSeries {
	time_zone: string;
	attention_budget: number;
	days: EmailMetricsDay[];
	totals: Omit<EmailMetricsDay, "date" | "inbox" | "unread" | "within_budget" | "by_account"> & {
		days_within_budget: number;
		days_observed: number;
		/** Mean needs-attention per day across the window's days that saw any decision. */
		avg_needs_attention: number | null;
		override_rate: number | null;
		override_rate_by_route: Record<EmailRoute, number | null>;
		override_rate_by_rubric_version: Record<string, number>;
		system_2_share: number | null;
	};
	override_rate: number | null;
	override_rate_by_route: Record<EmailRoute, number | null>;
	override_rate_by_rubric_version: Record<string, number>;
	latest_mailbox: { observed_at: string; inbox: number; unread: number; accounts: Record<string, MailboxCounts> } | null;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDateKey(instant: string | number | Date, timeZone = DEFAULT_EMAIL_METRICS_TIME_ZONE): string {
	const date = instant instanceof Date ? instant : new Date(instant);
	if (!Number.isFinite(date.getTime())) return "invalid";
	let fmt = formatterCache.get(timeZone);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
		formatterCache.set(timeZone, fmt);
	}
	return fmt.format(date);
}

/** The window's day keys, oldest first, ending on `now`'s local day. */
export function windowDateKeys(now: Date, days: number, timeZone = DEFAULT_EMAIL_METRICS_TIME_ZONE): string[] {
	const keys = new Set<string>();
	// Step in 12-hour increments so a DST change can never skip a local day.
	for (let i = 0; keys.size < days && i < days * 3; i += 1) {
		keys.add(localDateKey(new Date(now.getTime() - i * 12 * 60 * 60 * 1000), timeZone));
	}
	return Array.from(keys).slice(0, days).sort();
}

function emptyRoutes(): Record<EmailRoute, number> {
	return Object.fromEntries(EMAIL_ROUTES.map((r) => [r, 0])) as Record<EmailRoute, number>;
}

function emptyDay(date: string): EmailMetricsDay {
	return {
		date,
		inbox: null,
		unread: null,
		processed: 0,
		new: 0,
		needs_attention: 0,
		within_budget: true,
		attention_over_budget: 0,
		review: 0,
		review_resolved: 0,
		drafts_created: 0,
		tasks_extracted: 0,
		tasks_created: 0,
		entities_extracted: 0,
		auto_applied: 0,
		leaves_inbox: 0,
		system_1: 0,
		system_2: 0,
		gmail_category_contradictions: 0,
		overrides: 0,
		by_route: emptyRoutes(),
		by_account: {},
	};
}

const OVERRIDE_STATUSES = new Set(["modified", "rejected"]);

function isRoute(value: string | null | undefined): value is EmailRoute {
	return typeof value === "string" && (EMAIL_ROUTES as readonly string[]).includes(value);
}

/**
 * Build the daily series. Decisions without a route are pre-ADR-118 rows and are left
 * out: they were judged by a different rubric and would make the trend lie.
 */
export function buildEmailMetricsSeries(
	decisions: readonly EmailDecisionFact[],
	snapshots: readonly EmailMailboxSnapshot[],
	options: { now: Date; days: number; attentionBudget: number; timeZone?: string },
): EmailMetricsSeries {
	const timeZone = options.timeZone ?? DEFAULT_EMAIL_METRICS_TIME_ZONE;
	const keys = windowDateKeys(options.now, options.days, timeZone);
	const byDate = new Map(keys.map((k) => [k, emptyDay(k)]));
	const seenThreads = new Set<string>();
	const overridesByRoute = emptyRoutes();
	const byRubricVersion = new Map<string, { processed: number; overrides: number }>();

	const ordered = [...decisions].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
	for (const d of ordered) {
		if (!isRoute(d.route)) continue;
		const day = byDate.get(localDateKey(d.created_at, timeZone));
		if (!day) continue;
		const account = d.account ?? "unknown";
		const acct = (day.by_account[account] ??= { processed: 0, needs_attention: 0, inbox: null, unread: null });

		day.processed += 1;
		acct.processed += 1;
		const threadKey = `${account}:${d.thread_id ?? ""}`;
		if (d.thread_id && !seenThreads.has(threadKey)) {
			seenThreads.add(threadKey);
			day.new += 1;
		}
		day.by_route[d.route] += 1;
		if (INBOX_ROUTES.has(d.route)) {
			day.needs_attention += 1;
			acct.needs_attention += 1;
		} else {
			day.leaves_inbox += 1;
		}
		if (d.route === "review") {
			day.review += 1;
			if (d.status && d.status !== "pending") day.review_resolved += 1;
		}
		if (d.over_budget) day.attention_over_budget += 1;
		if (d.draft_id) day.drafts_created += 1;
		if (d.applied) day.auto_applied += 1;
		if (d.thinking_mode === "system_2") day.system_2 += 1;
		else day.system_1 += 1;
		if (d.gmail_category_contradiction) day.gmail_category_contradictions += 1;
		const isOverridden = Boolean(d.status && OVERRIDE_STATUSES.has(d.status));
		if (isOverridden) {
			day.overrides += 1;
			overridesByRoute[d.route] += 1;
		}
		if (typeof d.rubric_version === "string" && d.rubric_version.length > 0) {
			const rv = byRubricVersion.get(d.rubric_version) ?? { processed: 0, overrides: 0 };
			rv.processed += 1;
			if (isOverridden) rv.overrides += 1;
			byRubricVersion.set(d.rubric_version, rv);
		}
		day.tasks_extracted += d.tasks_extracted ?? 0;
		day.tasks_created += d.created_task_count ?? 0;
		day.entities_extracted += d.entities_extracted ?? 0;
	}

	// Snapshots: keep the latest observation per local day.
	const latestByDay = new Map<string, EmailMailboxSnapshot>();
	let latest: EmailMailboxSnapshot | null = null;
	for (const s of snapshots) {
		const key = localDateKey(s.observed_at, timeZone);
		const prev = latestByDay.get(key);
		if (!prev || Date.parse(s.observed_at) > Date.parse(prev.observed_at)) latestByDay.set(key, s);
		if (!latest || Date.parse(s.observed_at) > Date.parse(latest.observed_at)) latest = s;
	}
	for (const [key, snap] of latestByDay) {
		const day = byDate.get(key);
		if (!day) continue;
		let inbox = 0;
		let unread = 0;
		for (const [account, counts] of Object.entries(snap.accounts)) {
			inbox += counts.inbox;
			unread += counts.unread;
			const acct = (day.by_account[account] ??= { processed: 0, needs_attention: 0, inbox: null, unread: null });
			acct.inbox = counts.inbox;
			acct.unread = counts.unread;
		}
		day.inbox = inbox;
		day.unread = unread;
	}

	const days = keys.map((k) => {
		const day = byDate.get(k) as EmailMetricsDay;
		day.within_budget = day.needs_attention <= options.attentionBudget;
		return day;
	});

	const sum = (pick: (d: EmailMetricsDay) => number) => days.reduce((acc, d) => acc + pick(d), 0);
	const totalsRoutes = emptyRoutes();
	for (const d of days) for (const r of EMAIL_ROUTES) totalsRoutes[r] += d.by_route[r];
	const activeDays = days.filter((d) => d.processed > 0);
	const processed = sum((d) => d.processed);
	const system2 = sum((d) => d.system_2);
	const overrides = sum((d) => d.overrides);
	const round3 = (n: number, d: number) => Math.round((n / d) * 1000) / 1000;
	const overrideRate = processed > 0 ? round3(overrides, processed) : null;
	const overrideRateByRoute = Object.fromEntries(
		EMAIL_ROUTES.map((r) => [r, totalsRoutes[r] > 0 ? round3(overridesByRoute[r], totalsRoutes[r]) : null]),
	) as Record<EmailRoute, number | null>;
	const overrideRateByRubricVersion: Record<string, number> = {};
	for (const [ver, counts] of byRubricVersion) {
		if (counts.processed > 0) overrideRateByRubricVersion[ver] = round3(counts.overrides, counts.processed);
	}

	const latestTotals = latest
		? Object.values(latest.accounts).reduce(
				(acc, c) => ({ inbox: acc.inbox + c.inbox, unread: acc.unread + c.unread }),
				{ inbox: 0, unread: 0 },
			)
		: null;

	return {
		time_zone: timeZone,
		attention_budget: options.attentionBudget,
		days,
		totals: {
			processed,
			new: sum((d) => d.new),
			needs_attention: sum((d) => d.needs_attention),
			attention_over_budget: sum((d) => d.attention_over_budget),
			review: sum((d) => d.review),
			review_resolved: sum((d) => d.review_resolved),
			drafts_created: sum((d) => d.drafts_created),
			tasks_extracted: sum((d) => d.tasks_extracted),
			tasks_created: sum((d) => d.tasks_created),
			entities_extracted: sum((d) => d.entities_extracted),
			auto_applied: sum((d) => d.auto_applied),
			leaves_inbox: sum((d) => d.leaves_inbox),
			system_1: sum((d) => d.system_1),
			system_2: system2,
			gmail_category_contradictions: sum((d) => d.gmail_category_contradictions),
			overrides,
			by_route: totalsRoutes,
			days_within_budget: activeDays.filter((d) => d.within_budget).length,
			days_observed: activeDays.length,
			avg_needs_attention:
				activeDays.length > 0 ? Math.round((sum((d) => d.needs_attention) / activeDays.length) * 10) / 10 : null,
			override_rate: overrideRate,
			override_rate_by_route: overrideRateByRoute,
			override_rate_by_rubric_version: overrideRateByRubricVersion,
			system_2_share: processed > 0 ? round3(system2, processed) : null,
		},
		override_rate: overrideRate,
		override_rate_by_route: overrideRateByRoute,
		override_rate_by_rubric_version: overrideRateByRubricVersion,
		latest_mailbox:
			latest && latestTotals
				? { observed_at: latest.observed_at, inbox: latestTotals.inbox, unread: latestTotals.unread, accounts: latest.accounts }
				: null,
	};
}

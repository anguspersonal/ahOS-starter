/**
 * @ahkms/core/domain - emailMetrics.ts
 *
 * The email pipeline's scorecard (ADR-118). One success measure, the attention count
 * against the daily budget (target: fewer than 15 threads a day need the owner), plus
 * the flow counts that explain it: what is in the inbox, what arrived, what was
 * processed, where it went, and how often the owner had to correct the machine.
 *
 * Pure: computed from decisions the pipeline already holds, never from a second read.
 * Isomorphic: zero Node imports.
 */

import type { EmailIntentCategory } from "./emailTriage.js";
import { EMAIL_ROUTES, INBOX_ROUTES, type EmailRoute, type ThinkingMode } from "./emailRouting.js";

export interface MailboxCounts {
	/** Threads in the inbox. */
	inbox: number;
	/** Unread threads in the inbox. */
	unread: number;
}

export const EMAIL_OVERRIDE_STATUSES: ReadonlySet<string> = new Set(["modified", "rejected"]);

export function isEmailDecisionOverridden(decision: {
	overridden?: boolean | null;
	status?: string | null;
}): boolean {
	if (typeof decision.overridden === "boolean") return decision.overridden;
	return typeof decision.status === "string" && EMAIL_OVERRIDE_STATUSES.has(decision.status);
}

export interface MetricDecision {
	account: string;
	route: EmailRoute;
	intent_category: EmailIntentCategory;
	priority: number;
	thinking_mode: ThinkingMode;
	requires_human: boolean;
	applied?: boolean;
	over_budget?: boolean;
	draft_created?: boolean;
	tasks_extracted?: number;
	entities_extracted?: number;
	gmail_category_contradiction?: boolean;
	/** True when this run is the first to see the thread. */
	is_new?: boolean;
	overridden?: boolean;
	/** `system_decisions.status` (`modified` or `rejected` count as owner overrides). */
	status?: string | null;
	/** Rubric version the decision was judged under (`EMAIL_RUBRIC_VERSION`). */
	rubric_version?: string | null;
}

export interface EmailPipelineMetrics {
	/** Mailbox state before this run, per account and summed. */
	mailbox_before: Record<string, MailboxCounts> & { total: MailboxCounts };
	/** Threads evaluated this run. */
	processed: number;
	/** Of those, threads no earlier run had seen. */
	new: number;
	/** Routed to the owner (attention + draft_reply + review). The success measure. */
	needs_attention: number;
	attention_budget: number;
	attention_over_budget: number;
	within_budget: boolean;
	/** Needed a human decision because the HITL gate held it. */
	review: number;
	drafts_created: number;
	tasks_extracted: number;
	entities_extracted: number;
	/** Gmail changes applied (labels and archives) without the owner. */
	auto_applied: number;
	/** Threads projected to leave the inbox when the run acts. */
	leaves_inbox: number;
	system_1: number;
	system_2: number;
	/** Gmail's tab disagreed with the graph or a human ask: how much Gmail sorting is wrong. */
	gmail_category_contradictions: number;
	/** Owner corrections over decisions in the window (only when overrides are known). */
	override_rate: number | null;
	/** Override rate per route (`null` when route has zero decisions or overrides are unknown). */
	override_rate_by_route: Record<EmailRoute, number | null>;
	/** Override rate per `rubric_version` present in the decisions. */
	override_rate_by_rubric_version: Record<string, number>;
	by_route: Record<EmailRoute, number>;
	by_category: Partial<Record<EmailIntentCategory, number>>;
	by_account: Record<string, { processed: number; needs_attention: number }>;
}

function emptyRouteCounts(): Record<EmailRoute, number> {
	return Object.fromEntries(EMAIL_ROUTES.map((r) => [r, 0])) as Record<EmailRoute, number>;
}

function roundRate(num: number, den: number): number {
	return Math.round((num / den) * 1000) / 1000;
}

export function computeEmailPipelineMetrics(
	decisions: readonly MetricDecision[],
	options: {
		mailboxBefore?: Record<string, MailboxCounts>;
		attentionBudget: number;
	},
): EmailPipelineMetrics {
	const byRoute = emptyRouteCounts();
	const overriddenByRoute = emptyRouteCounts();
	const byRubricVersion = new Map<string, { total: number; overridden: number }>();
	const byCategory: Partial<Record<EmailIntentCategory, number>> = {};
	const byAccount: Record<string, { processed: number; needs_attention: number }> = {};
	let needsAttention = 0;
	let review = 0;
	let drafts = 0;
	let tasks = 0;
	let entities = 0;
	let autoApplied = 0;
	let leavesInbox = 0;
	let system1 = 0;
	let system2 = 0;
	let contradictions = 0;
	let isNew = 0;
	let overBudget = 0;
	let overridden = 0;
	let overrideKnown = false;

	for (const d of decisions) {
		byRoute[d.route] = (byRoute[d.route] ?? 0) + 1;
		byCategory[d.intent_category] = (byCategory[d.intent_category] ?? 0) + 1;
		const acct = (byAccount[d.account] ??= { processed: 0, needs_attention: 0 });
		acct.processed += 1;
		if (INBOX_ROUTES.has(d.route)) {
			needsAttention += 1;
			acct.needs_attention += 1;
		} else {
			leavesInbox += 1;
		}
		if (d.route === "review") review += 1;
		if (d.draft_created) drafts += 1;
		tasks += d.tasks_extracted ?? 0;
		entities += d.entities_extracted ?? 0;
		if (d.applied) autoApplied += 1;
		if (d.thinking_mode === "system_2") system2 += 1;
		else system1 += 1;
		if (d.gmail_category_contradiction) contradictions += 1;
		if (d.is_new) isNew += 1;
		if (d.over_budget) overBudget += 1;
		const hasOverrideSignal =
			typeof d.overridden === "boolean" || (typeof d.status === "string" && d.status.length > 0);
		const isOverridden = isEmailDecisionOverridden(d);
		if (hasOverrideSignal) {
			overrideKnown = true;
			if (isOverridden) {
				overridden += 1;
				overriddenByRoute[d.route] = (overriddenByRoute[d.route] ?? 0) + 1;
			}
		}
		if (typeof d.rubric_version === "string" && d.rubric_version.length > 0) {
			const rv = byRubricVersion.get(d.rubric_version) ?? { total: 0, overridden: 0 };
			rv.total += 1;
			if (isOverridden) rv.overridden += 1;
			byRubricVersion.set(d.rubric_version, rv);
		}
	}

	const overrideRateByRoute = Object.fromEntries(
		EMAIL_ROUTES.map((r) => [
			r,
			overrideKnown && byRoute[r] > 0 ? roundRate(overriddenByRoute[r], byRoute[r]) : null,
		]),
	) as Record<EmailRoute, number | null>;
	const overrideRateByRubricVersion: Record<string, number> = {};
	if (overrideKnown) {
		for (const [ver, counts] of byRubricVersion) {
			if (counts.total > 0) {
				overrideRateByRubricVersion[ver] = roundRate(counts.overridden, counts.total);
			}
		}
	}

	const before = options.mailboxBefore ?? {};
	const total = Object.values(before).reduce<MailboxCounts>(
		(acc, c) => ({ inbox: acc.inbox + c.inbox, unread: acc.unread + c.unread }),
		{ inbox: 0, unread: 0 },
	);

	return {
		mailbox_before: { ...before, total },
		processed: decisions.length,
		new: isNew,
		needs_attention: needsAttention,
		attention_budget: options.attentionBudget,
		attention_over_budget: overBudget,
		within_budget: needsAttention <= options.attentionBudget,
		review,
		drafts_created: drafts,
		tasks_extracted: tasks,
		entities_extracted: entities,
		auto_applied: autoApplied,
		leaves_inbox: leavesInbox,
		system_1: system1,
		system_2: system2,
		gmail_category_contradictions: contradictions,
		override_rate: overrideKnown && decisions.length > 0 ? roundRate(overridden, decisions.length) : null,
		override_rate_by_route: overrideRateByRoute,
		override_rate_by_rubric_version: overrideRateByRubricVersion,
		by_route: byRoute,
		by_category: byCategory,
		by_account: byAccount,
	};
}

/** The flat numeric subset that fits `scheduler_runs.counts` and a KPI row. */
export function flattenEmailPipelineMetrics(m: EmailPipelineMetrics): Record<string, number | boolean | null> {
	const flat: Record<string, number | boolean | null> = {
		inbox_before: m.mailbox_before.total.inbox,
		unread_before: m.mailbox_before.total.unread,
		processed: m.processed,
		new: m.new,
		needs_attention: m.needs_attention,
		attention_budget: m.attention_budget,
		attention_over_budget: m.attention_over_budget,
		within_budget: m.within_budget,
		review: m.review,
		drafts_created: m.drafts_created,
		tasks_extracted: m.tasks_extracted,
		entities_extracted: m.entities_extracted,
		auto_applied: m.auto_applied,
		leaves_inbox: m.leaves_inbox,
		system_1: m.system_1,
		system_2: m.system_2,
		gmail_category_contradictions: m.gmail_category_contradictions,
		override_rate: m.override_rate,
	};
	for (const [route, count] of Object.entries(m.by_route)) flat[`route_${route}`] = count;
	return flat;
}

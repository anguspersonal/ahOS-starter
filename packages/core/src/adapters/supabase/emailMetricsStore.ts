/**
 * @ahkms/core/adapters - Supabase reads for `gmail_triage_metrics` (ADR-118 §9, ADR-110 §1).
 *
 * Decision facts come from `system_decisions` as JSON projections of the payload, so a
 * 90-day read never pulls snippets or draft bodies. Mailbox snapshots are the one
 * `role = 'metrics'` artifact per day the triage run keeps up to date.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GmailTriageMetricsPort } from "../../ports/emailMetrics.js";
import type { EmailOwnerCorrectionExample } from "../../ports/emailReasoner.js";
import type { MailboxCounts } from "../../domain/emailMetrics.js";
import {
	EMAIL_MAILBOX_SNAPSHOT_SUBTYPE,
	type EmailDecisionFact,
	type EmailMailboxSnapshot,
} from "../../domain/emailMetricsSeries.js";
import { GMAIL_TRIAGE_DECISION_TYPE } from "./gmailReconcileStore.js";

export type EmailMetricsSupabaseClient = Pick<SupabaseClient, "from">;

export const EMAIL_DECISION_FACT_COLUMNS = [
	"created_at",
	"status",
	"thread_id:decision_payload->>thread_id",
	"account:decision_payload->>account",
	"route:decision_payload->>route",
	"natural_route:decision_payload->>natural_route",
	"thinking_mode:decision_payload->>thinking_mode",
	"applied:decision_payload->applied",
	"over_budget:decision_payload->over_budget",
	"draft_id:decision_payload->>draft_id",
	"gmail_category_contradiction:decision_payload->gmail_category_contradiction",
	"created_task_count:decision_payload->created_task_count",
	"extracted_tasks:decision_payload->extracted_tasks",
	"extracted_entities:decision_payload->extracted_entities",
	"rubric_version:decision_payload->>rubric_version",
	"sender:decision_payload->>sender",
	"sender_kind:decision_payload->>sender_kind",
	"gmail_category:decision_payload->>gmail_category",
	"intent_category:decision_payload->>intent_category",
	"priority:decision_payload->priority",
].join(",");

const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;

type DecisionFactRow = Omit<EmailDecisionFact, "tasks_extracted" | "entities_extracted"> & {
	extracted_tasks?: unknown;
	extracted_entities?: unknown;
};

function asBool(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function asCounts(value: unknown): MailboxCounts | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	return typeof v.inbox === "number" && typeof v.unread === "number" ? { inbox: v.inbox, unread: v.unread } : null;
}

export function createSupabaseEmailMetricsStore(
	client: EmailMetricsSupabaseClient,
	getUserId?: () => string | undefined,
): GmailTriageMetricsPort {
	const resolveUserId = (explicit?: string) => explicit ?? getUserId?.();

	return {
		async listDecisionFacts(sinceIso, userId) {
			const effectiveUserId = resolveUserId(userId);
			const out: EmailDecisionFact[] = [];
			for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
				let query = client
					.from("system_decisions")
					.select(EMAIL_DECISION_FACT_COLUMNS)
					.eq("decision_type", GMAIL_TRIAGE_DECISION_TYPE)
					.gte("created_at", sinceIso)
					.order("created_at", { ascending: true })
					.range(from, from + PAGE_SIZE - 1);
				if (effectiveUserId) query = query.eq("user_id", effectiveUserId);
				const { data, error } = await query;
				if (error) throw new Error(`gmail_triage_metrics: decision read failed: ${error.message}`);
				const rows = (data ?? []) as unknown as DecisionFactRow[];
				for (const row of rows) {
					out.push({
						created_at: row.created_at,
						status: row.status ?? null,
						thread_id: row.thread_id ?? null,
						account: row.account ?? null,
						route: row.route ?? null,
						natural_route: row.natural_route ?? null,
						thinking_mode: row.thinking_mode ?? null,
						applied: asBool(row.applied),
						over_budget: asBool(row.over_budget),
						draft_id: row.draft_id ?? null,
						gmail_category_contradiction: asBool(row.gmail_category_contradiction),
						created_task_count: typeof row.created_task_count === "number" ? row.created_task_count : 0,
						tasks_extracted: Array.isArray(row.extracted_tasks) ? row.extracted_tasks.length : 0,
						entities_extracted: Array.isArray(row.extracted_entities) ? row.extracted_entities.length : 0,
						rubric_version: row.rubric_version ?? null,
						sender: row.sender ?? null,
						sender_kind: row.sender_kind ?? null,
						gmail_category: row.gmail_category ?? null,
						intent_category: row.intent_category ?? null,
						priority: typeof row.priority === "number" ? row.priority : null,
					});
				}
				if (rows.length < PAGE_SIZE) break;
			}
			return out;
		},

		async listMailboxSnapshots(sinceIso, userId) {
			const effectiveUserId = resolveUserId(userId);
			let query = client
				.from("artifacts")
				.select("processing_metadata, updated_at")
				.eq("content_subtype", EMAIL_MAILBOX_SNAPSHOT_SUBTYPE)
				.eq("archived", false)
				.gte("updated_at", sinceIso)
				.order("updated_at", { ascending: true })
				.limit(200);
			if (effectiveUserId) query = query.eq("user_id", effectiveUserId);
			const { data, error } = await query;
			if (error) throw new Error(`gmail_triage_metrics: snapshot read failed: ${error.message}`);
			const out: EmailMailboxSnapshot[] = [];
			for (const row of (data ?? []) as Array<{ processing_metadata?: Record<string, unknown> | null; updated_at?: string }>) {
				const mailbox = row.processing_metadata?.mailbox as Record<string, unknown> | undefined;
				if (!mailbox || typeof mailbox.date !== "string") continue;
				const accounts: Record<string, MailboxCounts> = {};
				for (const [account, value] of Object.entries((mailbox.accounts ?? {}) as Record<string, unknown>)) {
					const counts = asCounts(value);
					if (counts) accounts[account] = counts;
				}
				out.push({
					date: mailbox.date,
					observed_at: typeof mailbox.observed_at === "string" ? mailbox.observed_at : (row.updated_at ?? mailbox.date),
					accounts,
				});
			}
			return out;
		},

		async listOwnerCorrections(limit = 5, userId) {
			const effectiveUserId = resolveUserId(userId);
			let query = client
				.from("system_decisions")
				.select(EMAIL_DECISION_FACT_COLUMNS)
				.eq("decision_type", GMAIL_TRIAGE_DECISION_TYPE)
				.in("status", ["modified", "rejected"])
				.order("created_at", { ascending: false })
				.limit(limit);
			if (effectiveUserId) query = query.eq("user_id", effectiveUserId);
			const { data, error } = await query;
			if (error) throw new Error(`gmail_triage_metrics: corrections read failed: ${error.message}`);
			return ((data ?? []) as unknown as DecisionFactRow[]).map((row) => ({
				sender: row.sender ?? null,
				sender_kind: row.sender_kind ?? "unknown",
				gmail_category: row.gmail_category ?? "unknown",
				system_1_verdict: row.natural_route ?? row.route ?? "unknown",
				owner_verdict: {
					category: row.intent_category ?? null,
					priority: typeof row.priority === "number" ? row.priority : null,
					route: row.route ?? null,
				},
			}));
		},
	};
}

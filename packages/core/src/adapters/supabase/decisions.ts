/**
 * Supabase adapter for DecisionRepository over `public.system_decisions` (#1664).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { JOB_APPLICATION_DECISION_TYPE } from "../../domain/jobApplicationEmail.js";
import {
	jobApplicationWatermarkKey,
	type DecisionListPageFilter,
	type DecisionListRecentFilter,
	type DecisionRepository,
	type DecisionResolveOptions,
	type JobApplicationWatermarkRecord,
	type SystemDecisionRow,
} from "../../ports/decisions.js";

export function createSupabaseDecisionRepository(
	supabase: Pick<SupabaseClient, "from">,
): DecisionRepository {
	return {
		async listRecent(
			filter: DecisionListRecentFilter,
			userId?: string,
		): Promise<SystemDecisionRow[]> {
			let query = supabase
				.from("system_decisions")
				.select("*")
				.order("created_at", { ascending: false })
				.limit(filter.limit ?? 20);

			if (userId) query = query.eq("user_id", userId);
			query = query.eq("status", filter.status || "pending");
			if (filter.blockingOnly) query = query.eq("blocking", true);
			if (filter.stage) query = query.eq("stage", filter.stage);
			if (filter.reviewType) query = query.eq("review_type", filter.reviewType);

			const { data, error } = await query;
			if (error) throw new Error(`Failed to list pending decisions: ${error.message}`);
			return (data ?? []) as SystemDecisionRow[];
		},

		async get(id: string, userId?: string): Promise<SystemDecisionRow> {
			let query = supabase.from("system_decisions").select("*").eq("id", id);
			if (userId) query = query.eq("user_id", userId);
			const { data, error } = await query.single();
			if (error) throw new Error(`Failed to get decision ${id}: ${error.message}`);
			return data as SystemDecisionRow;
		},

		async typesOf(
			ids: string[],
			userId?: string,
		): Promise<Array<{ id: string; decision_type?: string }>> {
			if (ids.length === 0) return [];
			let query = supabase.from("system_decisions").select("id, decision_type").in("id", ids);
			if (userId) query = query.eq("user_id", userId);
			const { data, error } = await query;
			if (error) throw new Error(`Failed to check decisions: ${error.message}`);
			return (data ?? []) as Array<{ id: string; decision_type?: string }>;
		},

		async resolve(
			ids: string[],
			patch: Record<string, unknown>,
			options?: DecisionResolveOptions,
			userId?: string,
		): Promise<SystemDecisionRow[]> {
			let query = supabase.from("system_decisions").update(patch);
			query = ids.length === 1 ? query.eq("id", ids[0]) : query.in("id", ids);
			if (options?.excludeType) query = query.neq("decision_type", options.excludeType);
			if (userId) query = query.eq("user_id", userId);
			if (ids.length === 1) {
				const { data, error } = await query.select().single();
				if (error) throw new Error(error.message);
				return data ? [data as SystemDecisionRow] : [];
			}
			const { data, error } = await query.select();
			if (error) throw new Error(error.message);
			return (data ?? []) as SystemDecisionRow[];
		},

		async listPage(
			filter: DecisionListPageFilter,
			userId: string,
		): Promise<{ rows: SystemDecisionRow[]; total: number }> {
			let query = supabase
				.from("system_decisions")
				.select("*", { count: "exact" })
				.eq("user_id", userId)
				.order("created_at", { ascending: true });

			if (filter.status && filter.status !== "all") query = query.eq("status", filter.status);
			if (filter.decisionType) query = query.eq("decision_type", filter.decisionType);

			const limit = filter.limit ?? 20;
			const offset = filter.offset ?? 0;
			query = query.range(offset, offset + limit - 1);

			const { data, count, error } = await query;
			if (error) throw new Error(`Failed to list review decisions: ${error.message}`);
			const rows = (data ?? []) as SystemDecisionRow[];
			return { rows, total: count ?? rows.length };
		},

		async getOne(id: string, userId: string): Promise<SystemDecisionRow | null> {
			const { data, error } = await supabase
				.from("system_decisions")
				.select("*")
				.eq("id", id)
				.eq("user_id", userId)
				.maybeSingle();
			if (error) throw new Error(`Failed to fetch system decision ${id}: ${error.message}`);
			return (data as SystemDecisionRow | null) ?? null;
		},

		async resolvePending(
			id: string,
			patch: Record<string, unknown>,
			userId: string,
		): Promise<boolean> {
			const { data, error } = await supabase
				.from("system_decisions")
				.update(patch)
				.eq("id", id)
				.eq("user_id", userId)
				.eq("status", "pending")
				.select("id");
			if (error) throw new Error(error.message);
			return Array.isArray(data) && data.length > 0;
		},

		async listJobApplicationWatermarks(
			messageIds: readonly string[],
			userId?: string,
		): Promise<Set<string>> {
			const result = new Set<string>();
			const uniqueIds = [...new Set(messageIds.filter(Boolean))];
			if (uniqueIds.length === 0) return result;

			const CHUNK_SIZE = 50;
			const PAGE_SIZE = 500;

			for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
				const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
				let offset = 0;
				while (true) {
					let query = supabase
						.from("system_decisions")
						.select("decision_payload")
						.eq("decision_type", JOB_APPLICATION_DECISION_TYPE)
						.neq("decision_payload->>mode", "shadow")
						.in("decision_payload->>message_id", chunk)
						.order("created_at", { ascending: true })
						.order("id", { ascending: true })
						.range(offset, offset + PAGE_SIZE - 1);
					if (userId) query = query.eq("user_id", userId);
					const { data, error } = await query;
					if (error) {
						throw new Error(`Failed to list job application watermarks: ${error.message}`);
					}
					const rows = (data ?? []) as Array<{ decision_payload?: Record<string, unknown> | null }>;
					for (const row of rows) {
						const payload = row.decision_payload;
						if (!payload || payload.mode === "shadow") continue;
						const msgId = typeof payload.message_id === "string" ? payload.message_id : null;
						if (!msgId) continue;
						const itemKey = typeof payload.item_key === "string" ? payload.item_key : "primary";
						result.add(jobApplicationWatermarkKey(msgId, itemKey));
					}
					if (rows.length < PAGE_SIZE) break;
					offset += PAGE_SIZE;
				}
			}
			return result;
		},

		async recordJobApplicationWatermarks(
			records: readonly JobApplicationWatermarkRecord[],
			userId?: string,
		): Promise<void> {
			if (records.length === 0) return;
			const rows = records.map((rec) => ({
				...(userId ? { user_id: userId } : {}),
				...(rec.artifact_id ? { artifact_id: rec.artifact_id } : {}),
				decision_type: JOB_APPLICATION_DECISION_TYPE,
				stage: "automate",
				title: rec.title ?? "Job application email update",
				description: rec.description ?? "",
				confidence_score: rec.confidence ?? null,
				blocking: false,
				user_visible: false,
				requires_user_action: false,
				review_type: "suggestion",
				status: "auto_applied",
				decision_payload: {
					message_id: rec.message_id,
					item_key: rec.item_key || "primary",
					mode: rec.mode,
					outcome: rec.outcome,
					...(rec.thread_id ? { thread_id: rec.thread_id } : {}),
					...(rec.application_id ? { application_id: rec.application_id } : {}),
					...(rec.decision_id ? { decision_id: rec.decision_id } : {}),
					...(rec.organisation ? { organisation: rec.organisation } : {}),
					...(rec.role_title ? { role_title: rec.role_title } : {}),
					...(rec.stage ? { stage: rec.stage } : {}),
					...(rec.candidate_ids?.length ? { candidate_ids: rec.candidate_ids } : {}),
					...(rec.candidates?.length ? { candidates: rec.candidates } : {}),
					...(rec.hiring_contact ? { hiring_contact: rec.hiring_contact } : {}),
				},
			}));
			const { error } = await supabase.from("system_decisions").insert(rows);
			if (error) {
				throw new Error(`Failed to record job application watermarks: ${error.message}`);
			}
		},
	};
}

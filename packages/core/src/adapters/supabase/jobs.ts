/**
 * @ahkms/core/adapters - Supabase persistence for the engine job runner
 * (ADR-101 §3, #1306 H1).
 *
 * Claims are atomic compare-and-set updates (`status = 'pending'` in the
 * WHERE clause) so two engine instances can never both run a job. Every
 * database error throws. `error_log` is `TEXT[]` and is always written as an
 * array. The original payload is preserved; a result is merged under `result`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRunnerPorts, SystemJobRow } from "../../engine/jobs/jobRunner.js";
import type { JobListRow, JobQueuePort, PendingJobRow } from "../../ports/jobQueue.js";

export type JobsSupabaseClient = Pick<SupabaseClient, "from">;

const JOB_COLUMNS =
	"id,user_id,type,status,payload,max_retries,current_attempt,error_log,scheduled_for,created_at";

/** What `job_list` reads. `user_id`, `priority` and the timestamps it does not show stay out. */
const JOB_LIST_COLUMNS =
	"id,type,status,payload,current_attempt,max_retries,scheduled_for,error_log,created_at";

function fail(what: string, error: { message: string } | null): never {
	throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
}

/** Enqueue a single action job into `system_jobs` (`type = actionId`, `payload = input`). */
export async function enqueueActionJob(
	client: JobsSupabaseClient,
	params: { actionId: string; input: unknown; userId?: string | null },
): Promise<{ id: string }> {
	const { data, error } = await client
		.from("system_jobs")
		.insert({ user_id: params.userId ?? null, type: params.actionId, status: "pending", payload: params.input })
		.select("id")
		.single();
	if (error || !data) fail(`Failed to enqueue ${params.actionId} job`, error);
	return { id: String((data as { id: unknown }).id) };
}

export function createSupabaseJobQueue(client: JobsSupabaseClient): JobQueuePort {
	return {
		async list(userId, query): Promise<JobListRow[]> {
			let select = client
				.from("system_jobs")
				.select(JOB_LIST_COLUMNS)
				.eq("user_id", userId)
				.in("status", [...query.statuses]);
			if (query.type) select = select.eq("type", query.type);
			const { data, error } = await select
				.order("created_at", { ascending: false })
				.limit(query.limit);
			if (error) fail("Failed to list jobs", error);
			return ((data ?? []) as unknown as JobListRow[]).map((row) => ({ ...row, id: String(row.id) }));
		},

		async listPending(userId, type, limit): Promise<PendingJobRow[]> {
			const { data, error } = await client
				.from("system_jobs")
				.select("id,payload")
				.eq("user_id", userId)
				.eq("type", type)
				.eq("status", "pending")
				.limit(limit);
			if (error) fail(`Failed to list pending ${type} jobs`, error);
			return ((data ?? []) as Array<{ id: unknown; payload: unknown }>).map((row) => ({
				id: String(row.id),
				payload: row.payload,
			}));
		},

		async enqueue(userId, type, payload): Promise<{ id: string }> {
			if (type === "entity_derive") {
				return enqueueActionJob(client, { actionId: "entity_derive", input: payload, userId });
			}
			return enqueueActionJob(client, { actionId: type, input: payload, userId });
		},
	};
}

export function createSupabaseJobPorts(client: JobsSupabaseClient): JobRunnerPorts {
	return {
		async fetchPendingJobs(limit): Promise<SystemJobRow[]> {
			const nowIso = new Date().toISOString();
			const { data, error } = await client
				.from("system_jobs")
				.select(JOB_COLUMNS)
				.eq("status", "pending")
				.or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
				.order("priority", { ascending: true })
				.order("created_at", { ascending: true })
				.limit(limit);
			if (error) fail("Failed to fetch pending jobs", error);
			return (data ?? []) as unknown as SystemJobRow[];
		},

		async fetchStaleJobs(staleBefore): Promise<SystemJobRow[]> {
			const { data, error } = await client
				.from("system_jobs")
				.select(JOB_COLUMNS)
				.eq("status", "processing")
				.lt("last_attempt_at", staleBefore)
				.limit(20);
			if (error) fail("Failed to fetch stale jobs", error);
			return (data ?? []) as unknown as SystemJobRow[];
		},

		async claimJob(id): Promise<SystemJobRow | null> {
			// Read the attempt counter, then compare-and-set on status. Only the
			// runner whose UPDATE matches the still-pending row gets a row back.
			const { data: current, error: readError } = await client
				.from("system_jobs")
				.select("current_attempt")
				.eq("id", id)
				.eq("status", "pending")
				.maybeSingle();
			if (readError) fail(`Failed to read job ${id}`, readError);
			if (!current) return null;

			const nowIso = new Date().toISOString();
			const { data, error } = await client
				.from("system_jobs")
				.update({
					status: "processing",
					current_attempt: ((current as { current_attempt: number | null }).current_attempt ?? 0) + 1,
					last_attempt_at: nowIso,
				})
				.eq("id", id)
				.eq("status", "pending")
				.select(JOB_COLUMNS);
			if (error) fail(`Failed to claim job ${id}`, error);
			const rows = (data ?? []) as unknown as SystemJobRow[];
			return rows[0] ?? null;
		},

		async completeJob(job, result): Promise<void> {
			const { data, error } = await client
				.from("system_jobs")
				.update({
					status: "completed",
					completed_at: new Date().toISOString(),
					payload: { ...(job.payload ?? {}), result },
				})
				.eq("id", job.id)
				.eq("status", "processing")
				.select("id");
			if (error) fail(`Failed to complete job ${job.id}`, error);
			if (!data || data.length === 0) {
				throw new Error(`Failed to complete job ${job.id}: row is no longer processing`);
			}
		},

		async failJob(job, message, retryAt): Promise<void> {
			const update: Record<string, unknown> = {
				status: retryAt ? "pending" : "failed",
				error_log: [...(job.error_log ?? []), message.slice(0, 1000)],
			};
			if (retryAt) update.scheduled_for = retryAt;
			const { data, error } = await client
				.from("system_jobs")
				.update(update)
				.eq("id", job.id)
				.eq("status", "processing")
				.select("id");
			if (error) fail(`Failed to mark job ${job.id} ${retryAt ? "for retry" : "failed"}`, error);
			if (!data || data.length === 0) {
				throw new Error(`Failed to mark job ${job.id} failed: row is no longer processing`);
			}
		},
	};
}

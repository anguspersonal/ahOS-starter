/**
 * @ahkms/core/ports - JobQueuePort
 *
 * Port for inspecting background jobs and enqueuing new action jobs into
 * `system_jobs` (ADR-101 §4, #1506, #2329).
 */

export interface PendingJobRow {
	id: string;
	payload: unknown;
}

/** The `system_jobs.status` CHECK constraint (migration 020). */
export const JOB_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobListQuery {
	statuses: readonly JobStatus[];
	type?: string;
	limit: number;
}

export interface JobListRow {
	id: string;
	type: string;
	status: JobStatus;
	payload: unknown;
	current_attempt: number | null;
	max_retries: number | null;
	scheduled_for: string | null;
	error_log: string[] | null;
	created_at: string;
}

export interface JobQueuePort {
	/** One user's jobs in the given statuses, newest first, at most `limit` rows. Read-only. */
	list(userId: string, query: JobListQuery): Promise<JobListRow[]>;
	listPending(userId: string, type: string, limit: number): Promise<PendingJobRow[]>;
	enqueue(userId: string, type: string, payload: unknown): Promise<{ id: string }>;
}

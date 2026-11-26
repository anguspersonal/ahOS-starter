import { z } from "zod";
import { defineAction } from "../defineAction.js";
import {
	JOB_STATUSES,
	type JobListRow,
	type JobQueuePort,
	type JobStatus,
} from "../../ports/jobQueue.js";

/** Statuses listed when the caller names none: the work still queued or running. */
export const JOB_LIST_DEFAULT_STATUSES: readonly JobStatus[] = ["pending", "processing"];
export const JOB_LIST_DEFAULT_LIMIT = 50;
export const JOB_LIST_MAX_LIMIT = 200;
/** Longest payload summary a row carries. The full payload is never returned. */
export const JOB_LIST_PAYLOAD_SUMMARY_MAX = 200;

export const JOB_LIST_DESCRIPTION =
	"List your background jobs in system_jobs, newest first: pending and processing ones by default, " +
	"or one status (completed, failed, cancelled). Each row shows type, status, age, attempts, the last " +
	"error and a short payload summary, never the full payload. Read-only: it cannot cancel or retry a job. " +
	"Full notes: docs/guides/tools/job_list.md";

export const jobListInput = {
	status: z
		.enum(JOB_STATUSES)
		.optional()
		.describe(
			"List only jobs in this status: pending, processing, completed, failed or cancelled. Omitted, pending and processing jobs are listed.",
		),
	type: z
		.string()
		.min(1)
		.optional()
		.describe("List only jobs of this type, which is the queued action id (for example 'entity_derive')."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(JOB_LIST_MAX_LIMIT)
		.optional()
		.describe("Maximum rows to return (1-200, default 50)."),
} as const;

export const jobListSchema = z.object(jobListInput);

export type JobListInput = z.infer<typeof jobListSchema>;

export interface JobListItem {
	id: string;
	type: string;
	status: JobStatus;
	created_at: string;
	scheduled_for: string | null;
	current_attempt: number;
	max_retries: number | null;
	/** The last entry of `error_log`, or null when the job has never failed. */
	last_error: string | null;
	/** The payload as JSON, cut to `JOB_LIST_PAYLOAD_SUMMARY_MAX` characters. */
	payload_summary: string;
}

export interface JobListOutput {
	statuses: JobStatus[];
	type?: string;
	limit: number;
	/** Counts over the rows returned, not over the whole table. */
	counts: {
		total: number;
		by_type: Record<string, number>;
		by_status: Record<string, number>;
	};
	jobs: JobListItem[];
}

function summarisePayload(payload: unknown): string {
	if (payload === null || payload === undefined) return "";
	const text = typeof payload === "string" ? payload : (JSON.stringify(payload) ?? "");
	if (text.length <= JOB_LIST_PAYLOAD_SUMMARY_MAX) return text;
	return `${text.slice(0, JOB_LIST_PAYLOAD_SUMMARY_MAX - 3)}...`;
}

function toItem(row: JobListRow): JobListItem {
	const errors = Array.isArray(row.error_log) ? row.error_log : [];
	return {
		id: row.id,
		type: row.type,
		status: row.status,
		created_at: row.created_at,
		scheduled_for: row.scheduled_for ?? null,
		current_attempt: row.current_attempt ?? 0,
		max_retries: row.max_retries ?? null,
		last_error: errors.length > 0 ? errors[errors.length - 1] : null,
		payload_summary: summarisePayload(row.payload),
	};
}

function tally(values: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

function countsLine(counts: Record<string, number>): string {
	return Object.entries(counts)
		.map(([key, n]) => `${key} ${n}`)
		.join(", ");
}

function jobLine(job: JobListItem): string {
	return [
		job.created_at,
		job.status,
		job.type,
		`attempt ${job.current_attempt}${job.max_retries === null ? "" : ` of ${job.max_retries}`}`,
		job.scheduled_for ? `scheduled ${job.scheduled_for}` : "",
		`job ${job.id}`,
		job.last_error ? `last error: ${job.last_error}` : "",
		job.payload_summary ? `payload: ${job.payload_summary}` : "",
	]
		.filter(Boolean)
		.join("  ");
}

export function formatJobListMcp(output: JobListOutput): string {
	const { counts, jobs, statuses, type, limit } = output;
	const scope = `status ${statuses.join(" or ")}${type ? `, type ${type}` : ""}`;
	const opening =
		counts.total === 0
			? `0 job(s) with ${scope}.`
			: `${counts.total} job(s). By type: ${countsLine(counts.by_type)}. By status: ${countsLine(counts.by_status)}.`;

	return [
		opening,
		...(counts.total === 0 ? [] : [`Listed: ${scope}, newest first, limit ${limit}.`]),
		...(counts.total >= limit
			? [`The limit was reached, so older jobs may exist. Raise limit (max ${JOB_LIST_MAX_LIMIT}) or narrow by status or type.`]
			: []),
		"",
		jobs.length ? jobs.map(jobLine).join("\n") : "(none)",
		"",
		"```json",
		JSON.stringify(jobs),
		"```",
	].join("\n");
}

/**
 * Read-only listing of the caller's `system_jobs` rows (#2329, owner decision 5
 * of the #2265 grill: queued work must be visible via a jobs listing).
 */
export function createJobListAction(jobs: JobQueuePort) {
	return defineAction({
		id: "job_list",
		domain: "ops",
		description: JOB_LIST_DESCRIPTION,
		schema: jobListSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args: JobListInput, ctx): Promise<JobListOutput> => {
			const userId = ctx?.userId?.trim();
			if (!userId) {
				throw new Error("job_list requires an authenticated userId in ActionContext.");
			}

			const statuses = args.status ? [args.status] : [...JOB_LIST_DEFAULT_STATUSES];
			const limit = args.limit ?? JOB_LIST_DEFAULT_LIMIT;
			const rows = await jobs.list(userId, {
				statuses,
				...(args.type !== undefined ? { type: args.type } : {}),
				limit,
			});

			const items = rows.map(toItem);
			return {
				statuses,
				...(args.type !== undefined ? { type: args.type } : {}),
				limit,
				counts: {
					total: items.length,
					by_type: tally(items.map((job) => job.type)),
					by_status: tally(items.map((job) => job.status)),
				},
				jobs: items,
			};
		},
		formatMcp: formatJobListMcp,
	});
}

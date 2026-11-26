import type { CadenceDefinition } from "../runner.js";
import { createEntityDeriveAction } from "../../actions/definitions/entityDerive.js";
import {
	executeAction,
	setDefaultAuditSink,
	stderrAuditSink,
} from "../../actions/adapters/direct.js";
import { ActionRegistry } from "../../actions/registry.js";
import type { EntityDerivePorts } from "../../actions/domain/derivePorts.js";
import type { ActionAuditRecord, ActionAuditSink, ActionDefinition } from "../../actions/types.js";

export interface SystemJobRow {
	id: string;
	user_id?: string | null;
	type: string;
	status: string;
	payload?: Record<string, unknown> | null;
	max_retries?: number | null;
	/** Attempts made so far, including the current one once claimed. */
	current_attempt?: number | null;
	error_log?: string[] | null;
	scheduled_for?: string | null;
	created_at?: string;
}

/**
 * Persistence port for the job runner (ADR-101 §3). Every method throws on a
 * database error; none swallows it.
 */
export interface JobRunnerPorts {
	fetchPendingJobs(limit: number): Promise<SystemJobRow[]>;
	/** Jobs stuck in `processing` since before `staleBefore` (ISO). */
	fetchStaleJobs(staleBefore: string): Promise<SystemJobRow[]>;
	/**
	 * Atomically moves a `pending` job to `processing` and increments its attempt
	 * counter. Returns the claimed row, or null if another runner won the claim.
	 */
	claimJob(id: string): Promise<SystemJobRow | null>;
	/** `processing` -> `completed`; merges `result` into the existing payload. */
	completeJob(job: SystemJobRow, result: Record<string, unknown>): Promise<void>;
	/**
	 * `processing` -> `failed` (retryAt null) or back to `pending` scheduled at
	 * `retryAt`. Appends `message` to the TEXT[] error_log.
	 */
	failJob(job: SystemJobRow, message: string, retryAt: string | null): Promise<void>;
}

export interface JobRunnerOptions {
	batchSize?: number;
	/** A `processing` job older than this is considered abandoned. */
	staleMs?: number;
	retryBackoffMs?: number;
	now?: () => number;
	auditSink?: ActionAuditSink;
}

const DEFAULT_BATCH = 5;
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_BACKOFF_MS = 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isZodError(err: unknown): boolean {
	return Boolean(err && typeof err === "object" && ((err as { name?: string }).name === "ZodError" || Array.isArray((err as { issues?: unknown }).issues)));
}

/** Pure retry policy: returns the next scheduled time, or null when retries are exhausted. */
export function nextRetryAt(
	job: SystemJobRow,
	nowMs: number,
	backoffMs = DEFAULT_RETRY_BACKOFF_MS,
): string | null {
	const attempt = job.current_attempt ?? 1;
	const max = job.max_retries ?? DEFAULT_MAX_RETRIES;
	if (attempt >= max) return null;
	return new Date(nowMs + attempt * backoffMs).toISOString();
}

/**
 * Processes pending system jobs (ADR-101 #1321, ADR-105 #1553). Also recovers
 * abandoned `processing` jobs: they are retried while attempts remain,
 * otherwise failed.
 */
export async function processSystemJobs(
	ports: JobRunnerPorts,
	registryOrDerivePorts: ActionRegistry | EntityDerivePorts,
	options: JobRunnerOptions = {},
): Promise<{ processed: number; completed: number; failed: number; retried: number; recovered: number }> {
	const nowMs = (options.now ?? Date.now)();
	const backoff = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

	let recovered = 0;
	const stale = await ports.fetchStaleJobs(new Date(nowMs - (options.staleMs ?? DEFAULT_STALE_MS)).toISOString());
	for (const job of stale) {
		await ports.failJob(job, "Job abandoned in processing (stale); recovering", nextRetryAt(job, nowMs, backoff));
		recovered++;
	}

	const pending = await ports.fetchPendingJobs(options.batchSize ?? DEFAULT_BATCH);
	const isRegistry = registryOrDerivePorts instanceof ActionRegistry;
	const legacyAction = isRegistry ? null : createEntityDeriveAction(registryOrDerivePorts);
	const lookupAction = (type: string) =>
		isRegistry ? registryOrDerivePorts.get(type) : legacyAction?.id === type ? legacyAction : undefined;
	let completed = 0;
	let failed = 0;
	let retried = 0;
	let processed = 0;

	for (const candidate of pending) {
		const job = await ports.claimJob(candidate.id);
		if (!job) continue; // another runner claimed it
		processed++;

		try {
			const action = lookupAction(job.type);
			if (!action) {
				const msg = isRegistry ? `Unknown job action: ${job.type}` : `Unknown job type: ${job.type}`;
				await ports.failJob(job, msg, null);
				failed++;
				continue;
			}
			if (!action.expose?.worker) {
				await ports.failJob(job, `Action ${action.id} is not exposed to worker`, null);
				failed++;
				continue;
			}
			if (job.user_id === null || (!isRegistry && !job.user_id)) {
				await ports.failJob(job, `${job.type} job has no user_id`, null);
				failed++;
				continue;
			}

			const jobAuditSink: ActionAuditSink | undefined = options.auditSink
				? (record) => options.auditSink!({ ...record, metadata: { job_id: job.id } } as ActionAuditRecord)
				: undefined;

			if (jobAuditSink) {
				setDefaultAuditSink(jobAuditSink);
			}
			let result: unknown;
			try {
				result = await executeAction(
					action as ActionDefinition<any, any>,
					job.payload ?? {},
					{
						context: {
							userId: job.user_id ?? undefined,
							caller: "worker",
							traceId: job.id,
							metadata: { job_id: job.id },
						},
						auditSink: jobAuditSink,
					},
				);
			} finally {
				if (jobAuditSink) {
					setDefaultAuditSink(stderrAuditSink);
				}
			}
			await ports.completeJob(job, result as unknown as Record<string, unknown>);
			completed++;
		} catch (err) {
			if (isZodError(err)) {
				await ports.failJob(job, `Invalid ${job.type} payload: ${errMessage(err)}`, null);
				failed++;
				continue;
			}
			const retryAt = nextRetryAt(job, nowMs, backoff);
			try {
				await ports.failJob(job, errMessage(err), retryAt);
			} catch (markErr) {
				// Leave the row in `processing`; stale recovery will pick it up.
				console.error(`[jobRunner] could not mark job ${job.id} failed:`, markErr);
			}
			if (retryAt) retried++;
			else failed++;
		}
	}

	return { processed, completed, failed, retried, recovered };
}

/**
 * Periodic jobs cadence registered on EngineRunner. Ports are required: the
 * composition root wires adapters (ADR-101 §3, ADR-105 #1553).
 */
export function createJobRunnerCadence(options: {
	ports: JobRunnerPorts;
	registry?: ActionRegistry;
	derivePorts?: EntityDerivePorts;
	intervalMs?: number;
	runnerOptions?: JobRunnerOptions;
}): CadenceDefinition {
	const target = (options.registry ?? options.derivePorts)!;
	return {
		name: "jobs",
		intervalMs: options.intervalMs ?? 15_000,
		enabled: () => true,
		// 15s ticks would write 5,760 scheduler_runs rows a day; only record work.
		shouldRecord: (counts) => Number(counts.processed ?? 0) + Number(counts.recovered ?? 0) > 0,
		run: async () => processSystemJobs(options.ports, target, options.runnerOptions),
	};
}

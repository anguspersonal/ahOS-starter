import { randomUUID } from "node:crypto";
import { executeAction } from "../../actions/adapters/direct.js";
import type { ActionAuditSink, ActionDefinition } from "../../actions/types.js";
import type {
	JobHuntGmailIngestResult,
	JobHuntGmailMode,
} from "../../actions/domain/jobhunt.js";

/**
 * Unknown or unset values fall back to "shadow", the mode that never writes to
 * Gmail or parks/executes approvals.
 */
export function parseJobHuntGmailMode(raw: string | undefined): JobHuntGmailMode {
	const value = (raw ?? "").trim().toLowerCase();
	return value === "label" || value === "act" ? value : "shadow";
}

export interface JobHuntActionLookup {
	get(id: string): ActionDefinition<any, any> | undefined;
}

export interface JobHuntGmailSweepOptions {
	userId: string;
	registry: JobHuntActionLookup;
	mode?: JobHuntGmailMode;
	maxMessages?: number;
	query?: string;
	dryRun?: boolean;
	auditSink?: ActionAuditSink;
}

export interface JobHuntGmailSweepResult {
	counts: Record<string, unknown>;
	error?: string;
	output: JobHuntGmailIngestResult | null;
}

/**
 * One job-hunt personal-mailbox Gmail ingestion sweep (ADR-120 Phase 2):
 * runs `job_hunt_gmail_ingest` strictly on `domain: "angus"` and returns
 * flattened counts for `scheduler_runs` (`connector: "job_hunt_gmail"`).
 * Never throws: a failed sweep comes back as `{ counts: {}, error, output: null }`.
 */
export async function runJobHuntGmailSweep(
	options: JobHuntGmailSweepOptions,
): Promise<JobHuntGmailSweepResult> {
	try {
		const action = options.registry.get("job_hunt_gmail_ingest");
		if (!action) {
			throw new Error('Action "job_hunt_gmail_ingest" not found in registry');
		}
		const output = (await executeAction(
			action,
			{
				domain: "angus",
				mode: options.mode ?? "shadow",
				dry_run: options.dryRun ?? false,
				...(options.query ? { query: options.query } : {}),
				max_messages: options.maxMessages ?? 50,
			},
			{
				context: {
					caller: "worker",
					userId: options.userId,
					requestId: randomUUID(),
					traceId: randomUUID(),
				},
				auditSink: options.auditSink,
			},
		)) as JobHuntGmailIngestResult;

		return {
			output,
			counts: {
				mode: output.mode,
				dry_run: output.dry_run,
				scanned_messages: output.scanned_messages,
				skipped_watermarked: output.skipped_watermarked,
				skipped_seeded_provenance: output.skipped_seeded_provenance,
				ignored_non_job: output.ignored_non_job,
				classified_updates: output.classified_updates,
				classified_tasks: output.classified_tasks,
				classified_evidence: output.classified_evidence,
				shadow_logged: output.shadow_logged,
				parked_approvals: output.parked_approvals,
				auto_applied: output.auto_applied,
				tasks_created: output.tasks_created,
				evidence_linked: output.evidence_linked,
				labels_added: output.labels_added,
				needs_review_count: output.needs_review_count,
				errors: output.errors.length,
			},
			error: output.errors.length > 0 ? output.errors.slice(0, 5).join("; ") : undefined,
		};
	} catch (err) {
		return {
			output: null,
			counts: {},
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

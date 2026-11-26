import { randomUUID } from "node:crypto";
import type { CadenceDefinition } from "../runner.js";
import { executeAction } from "../../actions/adapters/direct.js";
import type { ActionAuditSink, ActionDefinition } from "../../actions/types.js";
import type {
	GmailPriorityTriageOutput,
	GmailTriageMode,
} from "../../actions/google/gmailPriorityTriage.js";
import { flattenEmailPipelineMetrics } from "../../domain/emailMetrics.js";

export const GMAIL_TRIAGE_CADENCE_INTERVAL_MS = 60 * 60 * 1000;

/** Unknown or unset values fall back to "shadow", the mode that never writes to Gmail. */
export function parseGmailTriageMode(raw: string | undefined): GmailTriageMode {
	const value = (raw ?? "").trim().toLowerCase();
	return value === "label" || value === "act" ? value : "shadow";
}

export interface GmailTriageActionLookup {
	get(id: string): ActionDefinition<any, any> | undefined;
}

export interface GmailTriageSweepOptions {
	userId: string;
	registry: GmailTriageActionLookup;
	mode?: GmailTriageMode;
	maxThreads?: number;
	attentionBudget?: number;
	auditSink?: ActionAuditSink;
}

export interface GmailTriageSweepResult {
	counts: Record<string, unknown>;
	error?: string;
	output: GmailPriorityTriageOutput | null;
}

/**
 * One email pipeline sweep (ADR-118): runs the `gmail_priority_triage` registry action
 * across both mailboxes and returns the run counts, flattened for `scheduler_runs`.
 * Those rows (connector `gmail_triage`) are the inbox / new / processed time series.
 * Never throws: a failed sweep comes back as `{ counts: {}, error }`.
 */
export async function runGmailTriageSweep(options: GmailTriageSweepOptions): Promise<GmailTriageSweepResult> {
	try {
		const action = options.registry.get("gmail_priority_triage");
		if (!action) {
			throw new Error('Action "gmail_priority_triage" not found in registry');
		}
		const output = (await executeAction(
			action,
			{
				account: "all",
				mode: options.mode ?? "shadow",
				max_threads: options.maxThreads ?? 50,
				attention_budget: options.attentionBudget ?? 15,
				include_decisions: false,
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
		)) as GmailPriorityTriageOutput;

		return {
			output,
			counts: {
				mode: output.mode,
				rubric_version: output.rubric_version,
				skipped_already_decided: output.skipped_already_decided,
				promoted_artifacts: output.promoted_artifact_count,
				...flattenEmailPipelineMetrics(output.metrics),
				errors: output.errors.length,
			},
			error: output.errors.length > 0 ? output.errors.slice(0, 5).join("; ") : undefined,
		};
	} catch (err) {
		return { output: null, counts: {}, error: err instanceof Error ? err.message : String(err) };
	}
}

export interface GmailTriageCadenceOptions extends GmailTriageSweepOptions {
	intervalMs?: number;
	enabled?: () => boolean;
}

/**
 * The hourly engine cadence over `runGmailTriageSweep`. It holds the seeded
 * `gmail_automations` lock (shared with the reconcile sweep, so the two never touch a
 * mailbox at once) and records under connector `gmail_triage`.
 */
export function createGmailTriageCadence(options: GmailTriageCadenceOptions): CadenceDefinition {
	return {
		name: "gmail_automations",
		connector: "gmail_triage",
		intervalMs: options.intervalMs ?? GMAIL_TRIAGE_CADENCE_INTERVAL_MS,
		enabled: options.enabled ?? (() => true),
		run: async () => {
			const result = await runGmailTriageSweep(options);
			if (result.error && !result.output) throw new Error(result.error);
			return result.counts;
		},
	};
}

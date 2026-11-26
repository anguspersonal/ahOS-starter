import { randomUUID } from "node:crypto";
import { executeAction } from "@ahkms/core";
import type { GmailReconcileSummary } from "@ahkms/core/actions";
import { serverRegistry } from "../actions/serverRegistry.js";
import { getCurrentUserId } from "../identity.js";
import { recordRun } from "./runLog.js";

// Scheduled cadence runner for Gmail AhOS labeling and archive-on-resolve workflow (issue #356).
// Runs single-flighted via withLock("gmail_automations", ...) in schedule/index.ts,
// logging run history to scheduler_runs.
export async function runGmailAutomationsCadence(): Promise<void> {
	const startedAt = new Date();
	try {
		const action = serverRegistry().get("gmail_reconcile");
		if (!action) {
			throw new Error('Action "gmail_reconcile" not found in serverRegistry');
		}
		const requestId = randomUUID();
		const summary = (await executeAction(
			action,
			{ dry_run: false },
			{
				context: {
					caller: "worker",
					userId: getCurrentUserId(),
					requestId,
					traceId: requestId,
				},
			},
		)) as GmailReconcileSummary;

		const errorDetails =
			summary.errors > 0
				? `${summary.errors} thread(s) encountered errors during reconciliation`
				: undefined;

		await recordRun({
			cadence: "gmail_automations",
			connector: "gmail",
			startedAt,
			counts: {
				scanned: summary.scanned,
				updated: summary.updated,
				archived: summary.archived,
				pendingAction: summary.pendingAction,
				awaitingReply: summary.awaitingReply,
				capturedOnly: summary.capturedOnly,
				unchanged: summary.unchanged,
				errors: summary.errors,
			},
			error: errorDetails,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("gmail automations cadence failed:", message);
		await recordRun({
			cadence: "gmail_automations",
			connector: "gmail",
			startedAt,
			counts: {},
			error: message,
		});
	}
}

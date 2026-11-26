import { sweepCompletedAtDrift } from "../automations/completedAtStamp.js";
import { recordRun } from "./runLog.js";

// Daily reconciliation sweep for the Notion automations capability (#546 /
// ADR-048). The webhook (webhooks/notionWebhook.ts) is the fast path; this
// cadence is the correctness net that converges whatever the webhook missed
// (endpoint down, subscription broken, event dropped past Notion's retries).
// Runs under its own "notion_automations" single-flight lock (see
// schedule/index.ts and migration 082), gated by KMS_NOTION_AUTOMATIONS_ENABLED
// on top of the master KMS_SCHEDULER_ENABLED switch.

export async function runNotionAutomationsCadence(): Promise<void> {
	const startedAt = new Date();

	try {
		const counts = await sweepCompletedAtDrift();
		if (!counts) {
			// Rule not configured — the sweep already logged the setup hint; an
			// unconfigured tick is not a run worth a scheduler_runs row.
			return;
		}
		await recordRun({
			cadence: "notion_automations",
			connector: "notion",
			startedAt,
			counts,
			error:
				counts.errors > 0
					? `${counts.errors} page update(s) failed — see logs`
					: undefined,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("notion automations sweep failed:", message);
		await recordRun({
			cadence: "notion_automations",
			connector: "notion",
			startedAt,
			counts: {},
			error: message,
		});
	}
}

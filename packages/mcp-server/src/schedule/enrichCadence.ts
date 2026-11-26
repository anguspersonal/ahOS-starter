import { enrichNextCore } from "../tools/enrichNext.js";
import { recordRun } from "./runLog.js";
import { env as schedulerEnv } from "./env.js";

// Scheduled enrich cadence (ADR-016 Slice 3, #53): drains the 'discovered'
// backlog on a fixed budget (KMS_ENRICH_BATCH_LIMIT). Connector-agnostic —
// enrichNextCore only picks up pointers from connectors with a server-side read
// adapter (Google Drive today; see tools/enrich/adapters.ts), so this can run
// even before/after other connectors gain read adapters with no code change here.
export async function runEnrichCadence(): Promise<void> {
	const startedAt = new Date();
	try {
		const { enriched, failed, remaining_discovered, count_error } = await enrichNextCore({
			limit: schedulerEnv.enrichBatchLimit,
		});
		// A backlog count that failed is recorded as a FAILED run (#1209), with the
		// work counts kept and `remaining_discovered` null. Before, the count error
		// was swallowed into a 0 and every run read `ok, remaining_discovered=0`
		// while ~150k pointers sat queued — health reads on scheduler_runs reported
		// an empty backlog. The enrichment itself still happened and is still counted.
		await recordRun({
			cadence: "enrich",
			startedAt,
			counts: { enriched, failed, remaining_discovered },
			...(count_error ? { error: `remaining_discovered count failed: ${count_error}` } : {}),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("enrich cadence failed:", message);
		await recordRun({ cadence: "enrich", startedAt, counts: {}, error: message });
	}
}

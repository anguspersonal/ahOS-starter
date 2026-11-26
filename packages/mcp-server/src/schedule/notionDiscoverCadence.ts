import { executeAction } from "@ahkms/core";
import { searchNotion, notionResultTitle } from "../notion.js";
import type { NotionSearchResult } from "../notion.js";
import { sleep } from "../backoff.js";
import { getCredential } from "../credentials.js";
import { getCurrentUserId } from "../identity.js";
import { ingestDiscoverAction, softArchiveSourceTrashed } from "../tools/discover.js";
import { chunk } from "./chunk.js";
import { recordRun } from "./runLog.js";

// Scheduled discover cadence for Notion (ADR-016 Slice 3, #339). Lists the pages
// and databases each configured Notion workspace shares with the integration and
// hands them to `ingest_discover`'s write side in batches — the Notion sibling of the
// Google Drive cadence (driveDiscoverCadence.ts).
//
// Scope, deliberately kept minimal per #339:
//   - Full scan each run (no incremental checkpoint). Notion has no cheap content
//     hash, so content_hash = last_edited_time; an unchanged page is a cheap no-op
//     in ingest_discover (change-detected on that hash), which makes a full scan of a
//     small estate fine and avoids a per-connector scheduler checkpoint.
//   - Deletions are NOT detected (a removed page's pointer is never cleaned up) —
//     the same known gap as the Drive cadence, not this issue's job.
//   - Both workspaces fold into ONE cadence run with per-workspace error isolation
//     (one workspace failing never aborts the other), and both write the same
//     source_channel (discovered_notion) via a single "notion" connector — the
//     integration token already scopes each search to its own workspace.
//   - Runs under the shared "discover" lock/interval alongside Drive (see
//     schedule/discoverCadence.ts) rather than a separate lock: a new lock key
//     would need a seeded scheduler_locks row (a migration), and daily batch jobs
//     gain nothing from running concurrently.

const CONNECTOR = "notion";
const WORKSPACES = ["notion_work", "notion_personal"] as const;
// ingest_discover caps a single call at 200 items.
const BATCH_SIZE = 200;
// Notion's public API allows ~3 req/s. Pacing between pages keeps a large
// workspace's full scan under that proactively, so backoff (searchNotion's
// 429 retry, #474) stays the exception rather than the steady state. Applied
// only when another page follows — the common single-page workspace never waits.
const INTER_PAGE_DELAY_MS = 350;

/** Page through /v1/search for one workspace token, separating active and trashed objects (#1212). */
export async function searchAllNotion(token: string): Promise<{
	active: NotionSearchResult[];
	trashed: NotionSearchResult[];
}> {
	const active: NotionSearchResult[] = [];
	const trashed: NotionSearchResult[] = [];
	let cursor: string | undefined;
	do {
		const { results, next_cursor, has_more } = await searchNotion(token, { cursor });
		for (const r of results) {
			if (r.archived || r.in_trash) {
				trashed.push(r);
			} else {
				active.push(r);
			}
		}
		cursor = has_more ? (next_cursor ?? undefined) : undefined;
		if (cursor) await sleep(INTER_PAGE_DELAY_MS);
	} while (cursor);
	return { active, trashed };
}

export async function runNotionDiscoverCadence(): Promise<void> {
	const startedAt = new Date();

	let scanned = 0;
	let inserted = 0;
	let updated = 0;
	let unchanged = 0;
	let trashedTotal = 0;
	let configured = 0;
	const errors: string[] = [];

	for (const workspace of WORKSPACES) {
		let token: string;
		try {
			token = await getCredential(workspace);
		} catch {
			// Workspace not configured (token unset) - nothing to do, not an error.
			continue;
		}
		configured += 1;

		try {
			const { active, trashed } = await searchAllNotion(token);
			scanned += active.length;

			if (trashed.length > 0) {
				const trashedCount = await softArchiveSourceTrashed(
					CONNECTOR,
					trashed.map((r) => r.id),
				);
				trashedTotal += trashedCount;
			}

			for (const batch of chunk(active, BATCH_SIZE)) {
				const counts = await executeAction(ingestDiscoverAction, {
					connector: CONNECTOR,
					items: batch.map((r) => ({
						external_id: r.id,
						title: notionResultTitle(r),
						url: r.url ?? undefined,
						source_created_at: r.created_time ?? undefined,
						source_modified_at: r.last_edited_time ?? undefined,
						// No content hash in Notion - last_edited_time is the honest stand-in,
						// re-flagging a pointer exactly when Notion says the object changed.
						content_hash: r.last_edited_time ?? undefined,
					})),
				}, { context: { caller: "worker", userId: getCurrentUserId() } });
				inserted += counts.inserted;
				updated += counts.updated;
				unchanged += counts.unchanged;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`notion discover cadence failed for ${workspace}:`, message);
			errors.push(`${workspace}: ${message}`);
		}
	}

	if (configured === 0) {
		// No Notion workspace configured - nothing to do, and not a run worth a row.
		return;
	}

	await recordRun({
		cadence: "discover",
		connector: CONNECTOR,
		startedAt,
		counts: {
			scanned,
			new: inserted,
			changed: updated,
			unchanged,
			trashed: trashedTotal,
			workspaces: configured,
			errors: errors.length,
		},
		error: errors.length > 0 ? errors.join("; ") : undefined,
	});
}

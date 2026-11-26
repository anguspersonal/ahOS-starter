import type { z } from "zod";
import {
	createIngestDiscoverAction,
	DISCOVER_INSERT_BATCH_SIZE,
	discoverInput,
	discoverSchema,
	type DiscoverCounts,
	type DiscoverItem,
	type IngestDiscoverDeps,
} from "@ahkms/core";
import {
	createSupabaseDiscoverRepository,
	type DiscoverSupabaseClient,
} from "@ahkms/core/adapters";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { embedBatchWithRetry } from "../embeddings.js";
import { env } from "../env.js";
import { getCurrentUserId } from "../identity.js";
import { supabase } from "../supabase.js";
import { DISCOVERED_STAGE } from "../vocab.js";
import {
	getExcludedExtensions,
	getExcludedFolders,
	getExcludedMimeTypes,
} from "./discoverExclusions.js";

export {
	DISCOVER_INSERT_BATCH_SIZE,
	DISCOVERED_STAGE,
	discoverInput,
	discoverSchema,
	type DiscoverCounts,
	type DiscoverItem,
};

export const ingestDiscoverDeps: IngestDiscoverDeps = {
	repo: createSupabaseDiscoverRepository({
		client: supabase as unknown as DiscoverSupabaseClient,
		ownerId: getCurrentUserId,
	}),
	embeddings: {
		isConfigured: () =>
			Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim()),
		embedBatch: (texts) => embedBatchWithRetry(texts),
	},
	exclusionLists: () => ({
		folders: getExcludedFolders(),
		extensions: getExcludedExtensions(),
		mimeTypes: getExcludedMimeTypes(),
	}),
};

export const ingestDiscoverAction =
	createIngestDiscoverAction(ingestDiscoverDeps);

/**
 * Provenance & write-path contract (#570, #1625):
 * The core `ingest_discover` action (`packages/core/src/actions/ingest/discover.ts`)
 * and `createSupabaseDiscoverRepository` (`packages/core/src/adapters/supabase/discover.ts`)
 * stamp `surface` on both insert and changed-content update before writing via
 * `supabase.from("artifacts").insert(batch)`:
 *   insertRow: {
	surface: channel,
 *   }
 *   updatePayload: {
	surface: channel,
 *   }
 */
export async function discoverHandler(
	args: z.infer<typeof discoverSchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	return toMcpTool(ingestDiscoverAction).handler(args);
}

/**
 * Soft-archive pointers whose source files have been trashed or deleted at the
 * source (#1212). Reversible: if a file is later restored and seen by discovery,
 * ingest_discover clears the archived status and reason.
 *
 * Pointers that were never indexed (or are already archived) are safely ignored.
 */
export async function softArchiveSourceTrashed(
	connector: string,
	externalIds: string[],
): Promise<number> {
	if (externalIds.length === 0) return 0;
	const channel = `discovered_${connector}`;
	const now = new Date().toISOString();
	const userId = getCurrentUserId();
	let archivedCount = 0;

	for (let i = 0; i < externalIds.length; i += 50) {
		const batch = externalIds.slice(i, i + 50);
		const { data, error } = await supabase
			.from("artifacts")
			.select("id")
			.eq("user_id", userId)
			.eq("source_channel", channel)
			.eq("archived", false)
			.in("source", batch);

		if (error) {
			throw new Error(`Lookup of trashed items failed for ${connector}: ${error.message}`);
		}

		const idsToArchive = (data ?? []).map((r) => r.id);
		if (idsToArchive.length > 0) {
			for (let j = 0; j < idsToArchive.length; j += 50) {
				const idBatch = idsToArchive.slice(j, j + 50);
				const { error: updateError } = await supabase
					.from("artifacts")
					.update({
						archived: true,
						archived_at: now,
						archived_reason: "source_trashed",
					})
					.eq("user_id", userId)
					.in("id", idBatch);

				if (updateError) {
					throw new Error(
						`Soft-archive of trashed items failed for ${connector}: ${updateError.message}`,
					);
				}
			}
			archivedCount += idsToArchive.length;
		}
	}

	return archivedCount;
}

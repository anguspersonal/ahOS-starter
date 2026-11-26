import type { SupabaseClient } from "@supabase/supabase-js";
import { NOT_A_FOLDER_FILTER } from "../../domain/ingest/selection.js";
import type { EnrichPointerRow, EnrichRepository } from "../../ports/enrich.js";

export type EnrichSupabaseClient = Pick<SupabaseClient, "from">;

const BACKLOG_COLUMNS =
	"id, title, description, source, source_channel, storage_bucket, storage_path, storage_url, source_url, plain_text, lifecycle_stage, processing_metadata";
const ON_DEMAND_COLUMNS = BACKLOG_COLUMNS.replace("processing_metadata", "processing_status, processing_metadata");

/**
 * Supabase adapter for `EnrichRepository` (#2322). Each method is the query
 * `ingest_enrich_next` ran inline before the move into core, unchanged. `now` is
 * the clock for `enrichment_failed_at` and `discovery.enriched_at`.
 */
export function createSupabaseEnrichRepository(
	client: EnrichSupabaseClient,
	{ now = () => new Date() }: { now?: () => Date } = {},
): EnrichRepository {
	// The backlog: discovered, unarchived, on a readable channel, and not a recorded
	// Drive folder (#1228: no bytes, so it would only burn budget on a certain failure).
	const backlog = (userId: string, channels: string[], columns: string, options?: { count: "estimated"; head: true }) =>
		client
			.from("artifacts")
			.select(columns, options)
			.eq("user_id", userId)
			.eq("lifecycle_stage", "discovered")
			.eq("archived", false)
			.in("source_channel", channels)
			.or(NOT_A_FOLDER_FILTER);

	return {
		async selectDiscovered(userId, { channels, limit }) {
			const { data, error } = await backlog(userId, channels, BACKLOG_COLUMNS)
				.order("effective_at", { ascending: false })
				.order("captured_at", { ascending: false })
				.limit(limit);
			if (error) throw new Error(`ingest_enrich_next selection failed: ${error.message}`);
			return (data ?? []) as unknown as EnrichPointerRow[];
		},

		// `estimated`, not `exact`: an exact count over ~150k wide pointer rows timed
		// out (57014) on every scheduled run and was reported as an empty backlog (#1209).
		async countDiscovered(userId, channels) {
			const { count, error } = await backlog(userId, channels, "id", { count: "estimated", head: true });
			if (error) return { count: null, error: error.message || "backlog count failed" };
			if (count == null) return { count: null, error: "backlog count returned no count" };
			return { count };
		},

		// Throws the database message unprefixed: the caller words its own note.
		async loadById(userId, id) {
			const { data, error } = await client
				.from("artifacts")
				.select(ON_DEMAND_COLUMNS)
				.eq("user_id", userId)
				.eq("id", id)
				.maybeSingle();
			if (error) throw new Error(error.message);
			return (data as unknown as EnrichPointerRow | null) ?? null;
		},

		async markFailed(userId, row, message) {
			await client
				.from("artifacts")
				.update({
					lifecycle_stage: "failed",
					processing_status: "failed",
					processing_metadata: {
						...(row.processing_metadata ?? {}),
						enrichment_error: message,
						enrichment_failed_at: now().toISOString(),
					},
				})
				.eq("id", row.id)
				.eq("user_id", userId);
		},

		async promote(userId, id, patch) {
			const priorDiscovery = patch.processingMetadata?.discovery ?? {};
			const { error } = await client
				.from("artifacts")
				.update({
					storage_bucket: patch.storageBucket,
					storage_path: patch.storagePath,
					storage_url: patch.storageUrl,
					file_type: patch.mimeType,
					content_type: patch.mimeType,
					file_extension: patch.extension,
					file_size: patch.fileSize,
					plain_text: patch.plainText,
					title: patch.title,
					description: patch.description,
					lifecycle_stage: "extracted",
					processing_status: patch.processingStatus,
					processing_metadata: {
						...(patch.processingMetadata ?? {}),
						discovery: {
							...priorDiscovery,
							connector: priorDiscovery.connector ?? patch.connector,
							content_hash: patch.contentHash ?? priorDiscovery.content_hash ?? null,
							enriched_at: now().toISOString(),
						},
					},
				})
				.eq("id", id)
				.eq("user_id", userId);
			if (error) throw new Error(`row update failed: ${error.message}`);
		},
	};
}

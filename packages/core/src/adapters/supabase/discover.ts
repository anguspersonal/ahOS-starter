import type { SupabaseClient } from "@supabase/supabase-js";
import type {
	EnvelopeRefreshRow,
	ExistingRow,
} from "../../domain/ingest/discoverPointers.js";
import {
	DISCOVER_INSERT_BATCH_SIZE,
	DISCOVER_LOOKUP_BATCH_SIZE,
	type DiscoverRepository,
} from "../../ports/discover.js";

export type DiscoverSupabaseClient = Pick<SupabaseClient, "from" | "rpc">;

export interface SupabaseDiscoverRepositoryOptions {
	client: DiscoverSupabaseClient;
	ownerId?: string | (() => string);
}

function isOptionsObject(
	input: DiscoverSupabaseClient | SupabaseDiscoverRepositoryOptions,
): input is SupabaseDiscoverRepositoryOptions {
	return typeof input === "object" && input !== null && "client" in input;
}

export function createSupabaseDiscoverRepository(
	clientOrOptions: DiscoverSupabaseClient | SupabaseDiscoverRepositoryOptions,
	ownerIdArg?: string | (() => string),
): DiscoverRepository {
	const client = isOptionsObject(clientOrOptions)
		? clientOrOptions.client
		: clientOrOptions;
	const ownerIdSource = isOptionsObject(clientOrOptions)
		? clientOrOptions.ownerId
		: ownerIdArg;

	const resolveOwnerId = (fallback?: string): string => {
		if (fallback) return fallback;
		if (typeof ownerIdSource === "function") return ownerIdSource();
		return ownerIdSource ?? "";
	};

	return {
		async findKnown(
			userId: string,
			channel: string,
			sources: string[],
		): Promise<ExistingRow[]> {
			const effectiveUserId = userId || resolveOwnerId();
			const existingRows: ExistingRow[] = [];
			for (let i = 0; i < sources.length; i += DISCOVER_LOOKUP_BATCH_SIZE) {
				const batch = sources.slice(i, i + DISCOVER_LOOKUP_BATCH_SIZE);
				const { data, error } = await client
					.from("artifacts")
					.select("id, source, processing_metadata, archived, archived_reason")
					.eq("user_id", effectiveUserId)
					.eq("source_channel", channel)
					.in("source", batch);

				if (error) {
					throw new Error(`Discovery lookup failed: ${error.message}`);
				}
				if (data) {
					existingRows.push(...(data as ExistingRow[]));
				}
			}
			return existingRows;
		},

		async insert(rows: Record<string, unknown>[]): Promise<void> {
			for (let i = 0; i < rows.length; i += DISCOVER_INSERT_BATCH_SIZE) {
				const batch = rows.slice(i, i + DISCOVER_INSERT_BATCH_SIZE);
				const table = client.from("artifacts");
				const { error } = await table.insert(batch);
				if (error) {
					throw new Error(`Discovery insert failed: ${error.message}`);
				}
			}
		},

		async update(
			id: string,
			patch: Record<string, unknown>,
			externalId?: string,
		): Promise<void> {
			const { error } = await client
				.from("artifacts")
				.update(patch)
				.eq("id", id)
				.eq("user_id", resolveOwnerId());

			if (error) {
				const derivedExtId = (
					patch.processing_metadata as
						| { discovery?: { external_id?: string } }
						| undefined
				)?.discovery?.external_id;
				const label = externalId ?? derivedExtId ?? id;
				throw new Error(`Discovery update failed for ${label}: ${error.message}`);
			}
		},

		async refreshEnvelopes(
			rows: EnvelopeRefreshRow[],
			userId?: string,
		): Promise<number> {
			if (rows.length === 0) return 0;
			const { data, error } = await client.rpc("discover_envelope_refresh", {
				p_user_id: resolveOwnerId(userId),
				p_rows: rows,
			});
			if (error) {
				throw new Error(
					`Discovery envelope refresh failed for ${rows.length} row(s): ${error.message}`,
				);
			}
			return typeof data === "number" ? data : 0;
		},
	};
}

/**
 * Supabase adapter for EmbeddingStorePort and EmbeddingBackfillStore (#1615, #1617, ADR-047, ADR-101 section 3).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
	BackfillRow,
	EmbeddableTable,
	EmbeddingBackfillStore,
} from "../../ports/embeddings.js";

export type EmbeddingStoreSupabaseClient = Pick<SupabaseClient, "from">;

export interface SupabaseEmbeddingStoreOptions {
	client: EmbeddingStoreSupabaseClient;
	ownerId?: string | (() => string | undefined);
}

const SELECT_COLUMNS: Record<EmbeddableTable, string> = {
	artifacts: "id, title, description, plain_text, extracted_content",
	entities: "id, title, description, properties, aliases",
};

export function createSupabaseEmbeddingStore(
	optionsOrClient: SupabaseEmbeddingStoreOptions | EmbeddingStoreSupabaseClient,
): EmbeddingBackfillStore {
	const options: SupabaseEmbeddingStoreOptions =
		"client" in optionsOrClient ? optionsOrClient : { client: optionsOrClient };

	const resolveOwnerId = (override?: string): string => {
		if (override && override.length > 0) return override;
		if (!options.ownerId) return "";
		return (typeof options.ownerId === "function" ? options.ownerId() : options.ownerId) ?? "";
	};

	return {
		async setEmbedding(table: EmbeddableTable, id: string, vector: number[]): Promise<void> {
			const { error } = await options.client
				.from(table)
				.update({ embedding: JSON.stringify(vector) })
				.eq("id", id);
			if (error) {
				throw new Error(`row update failed: ${error.message ?? String(error)}`);
			}
		},

		async selectUnembeddedBatch(
			table: EmbeddableTable,
			batchSize: number,
			afterId: string | null,
			userId?: string,
		): Promise<BackfillRow[]> {
			const activeUserId = resolveOwnerId(userId);
			let query = options.client
				.from(table)
				.select(SELECT_COLUMNS[table])
				.eq("user_id", activeUserId)
				.eq("archived", false)
				.is("embedding", null)
				.order("id", { ascending: true })
				.limit(batchSize);
			if (afterId) {
				query = query.gt("id", afterId);
			}
			const { data, error } = await query;
			if (error) {
				throw new Error(`backfill selection failed: ${error.message ?? String(error)}`);
			}
			return (data ?? []) as unknown as BackfillRow[];
		},

		async countRemaining(table: EmbeddableTable, userId?: string): Promise<number> {
			const activeUserId = resolveOwnerId(userId);
			const { count, error } = await options.client
				.from(table)
				.select("id", { count: "exact", head: true })
				.eq("user_id", activeUserId)
				.eq("archived", false)
				.is("embedding", null);
			if (error) {
				throw new Error(`backfill remaining-count failed: ${error.message ?? String(error)}`);
			}
			return count ?? 0;
		},
	};
}


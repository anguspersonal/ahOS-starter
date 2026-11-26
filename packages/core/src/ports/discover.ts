import type {
	EnvelopeRefreshRow,
	ExistingRow,
} from "../domain/ingest/discoverPointers.js";

/**
 * Maximum number of rows inserted per PostgREST `INSERT INTO artifacts` call.
 * Each row carries a 1536-float vector plus JSONB metadata; inserting 200 rows in a
 * single statement on the ~153k-row artifacts table can exceed PostgREST's 8s
 * statement_timeout while updating the HNSW embedding index and GIN indexes.
 */
export const DISCOVER_INSERT_BATCH_SIZE = 25;

/**
 * Maximum number of external IDs queried per `IN (...)` lookup batch to avoid
 * statement timeouts on large predicates (#1207).
 */
export const DISCOVER_LOOKUP_BATCH_SIZE = 50;

export interface DiscoverRepository {
	findKnown(
		userId: string,
		channel: string,
		sources: string[],
	): Promise<ExistingRow[]>;
	insert(rows: Record<string, unknown>[]): Promise<void>;
	update(
		id: string,
		patch: Record<string, unknown>,
		externalId?: string,
	): Promise<void>;
	refreshEnvelopes(rows: EnvelopeRefreshRow[], userId?: string): Promise<number>;
}

/**
 * Embedding port contract consumed by `ingest_discover`.
 * Compatible with `EmbeddingPort` (`Promise<number[][]>`) as well as best-effort
 * batch embedders that return `null` per failed item instead of throwing.
 */
export interface DiscoverEmbeddingPort {
	embedBatch(texts: string[]): Promise<(number[] | null)[]>;
	isConfigured?(): boolean;
}

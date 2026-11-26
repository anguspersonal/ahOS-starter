/**
 * Embedding provider and embedding store ports (#1615, ADR-047, ADR-101 section 3).
 */

/** Tables carrying an `embedding vector(1536)` column (ADR-047). */
export type EmbeddableTable = "artifacts" | "entities";

export interface EmbeddingPort {
	embed(text: string): Promise<number[]>;
	embedBatch(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingStorePort {
	setEmbedding(table: EmbeddableTable, id: string, vector: number[]): Promise<void>;
}

export type BackfillArtifactRow = {
	id: string;
	title: string | null;
	description: string | null;
	plain_text: string | null;
	extracted_content: string | null;
};

export type BackfillEntityRow = {
	id: string;
	title: string | null;
	description: string | null;
	properties: Record<string, unknown> | null;
	aliases?: string[] | null;
};

export type BackfillRow = BackfillArtifactRow | BackfillEntityRow;

export interface EmbeddingBackfillStore extends EmbeddingStorePort {
	selectUnembeddedBatch(
		table: EmbeddableTable,
		batchSize: number,
		afterId: string | null,
		userId?: string,
	): Promise<BackfillRow[]>;
	countRemaining(table: EmbeddableTable, userId?: string): Promise<number>;
}


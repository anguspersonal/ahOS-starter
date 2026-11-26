import {
	embedAndStore as coreEmbedAndStore,
	embedEntityText,
	embedText,
	withEmbeddingRetry,
	type EmbedAndStoreOutcome,
	type EmbeddableFields,
	type EmbeddableTable,
	type EmbedFields,
	type EmbedOutcome,
	type EmbeddingPort,
	type EntityEmbeddableFields,
	type EntityEmbedFields,
	type RetryOptions,
} from "@ahkms/core";
import {
	createGeminiEmbeddingAdapter,
	createOpenAiEmbeddingAdapter,
	createSupabaseEmbeddingStore,
} from "@ahkms/core/adapters";
import { env } from "./env.js";
import { supabase } from "./supabase.js";

export {
	embedEntityText,
	embedText,
	type EmbedAndStoreOutcome,
	type EmbeddableFields,
	type EmbeddableTable,
	type EmbedFields,
	type EmbedOutcome,
	type EntityEmbeddableFields,
	type EntityEmbedFields,
};

const geminiEmbeddingAdapter = createGeminiEmbeddingAdapter({
	apiKey: () => env.geminiApiKey,
	model: () => env.geminiEmbedModel,
});

const openAiEmbeddingAdapter = createOpenAiEmbeddingAdapter({
	apiKey: () => env.openaiApiKey,
	model: () => env.embedModel,
});

function activeEmbeddingAdapter(): EmbeddingPort {
	return env.geminiApiKey?.trim() ? geminiEmbeddingAdapter : openAiEmbeddingAdapter;
}

const embeddingAdapter: EmbeddingPort = {
	embed: (text: string) => activeEmbeddingAdapter().embed(text),
	embedBatch: (texts: string[]) => activeEmbeddingAdapter().embedBatch(texts),
};

export async function embed(text: string): Promise<number[]> {
	return embeddingAdapter.embed(text);
}

/**
 * Embed several texts in ONE provider request. Vectors come back aligned to
 * `texts` by index.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
	return embeddingAdapter.embedBatch(texts);
}

/** `embed`, retrying transient provider failures (429 / 5xx / connection blips). */
export async function embedWithRetry(text: string, options?: RetryOptions): Promise<number[]> {
	return withEmbeddingRetry(() => embed(text), options);
}

const EMBED_CHUNK_SIZE = 100;

/**
 * Embed many texts, chunked, with backoff per chunk. Best-effort per chunk: a
 * chunk that still fails after its retries yields `null` for each of its inputs
 * rather than discarding the chunks that did succeed. Never throws.
 */
export async function embedBatchWithRetry(
	texts: string[],
	options?: RetryOptions,
): Promise<(number[] | null)[]> {
	const out: (number[] | null)[] = [];
	for (let i = 0; i < texts.length; i += EMBED_CHUNK_SIZE) {
		const chunk = texts.slice(i, i + EMBED_CHUNK_SIZE);
		try {
			const vectors = await withEmbeddingRetry(() => embedBatch(chunk), options);
			out.push(...vectors);
		} catch (err) {
			process.stderr.write(
				`[embedBatch] chunk at ${i} (${chunk.length} texts) failed: ${String(err)}\n`,
			);
			out.push(...chunk.map(() => null));
		}
	}
	return out;
}

/**
 * Best-effort: build the embed text, call the API (with backoff on 429/5xx), write
 * to `<table>.embedding`. Logs errors to stderr but never throws.
 */
export async function embedAndStore(
	table: EmbeddableTable,
	id: string,
	fields: EmbeddableFields | EntityEmbeddableFields,
): Promise<EmbedOutcome> {
	if (!env.geminiApiKey?.trim() && !env.openaiApiKey?.trim()) return "skipped";
	return coreEmbedAndStore(
		embeddingAdapter,
		createSupabaseEmbeddingStore(supabase),
		table,
		id,
		fields,
		{
			onError: (err) => {
				process.stderr.write(`[embedAndStore] ${table}/${id}: ${String(err)}\n`);
			},
		},
	);
}

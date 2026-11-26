import {
	backfillExitCode,
	runCoreEmbeddingBackfill,
	type BackfillOptions,
	type BackfillResult,
} from "@ahkms/core";
import { createSupabaseEmbeddingStore } from "@ahkms/core/adapters";
import { supabase } from "../supabase.js";
import { env } from "../env.js";
import { getCurrentUserId } from "../identity.js";
import { embedText, embedEntityText, embedWithRetry } from "../embeddings.js";

export { backfillExitCode, type BackfillOptions, type BackfillResult };

export async function runEmbeddingBackfill(
	options: BackfillOptions = {},
): Promise<BackfillResult> {
	const hasKey = Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim());
	return runCoreEmbeddingBackfill(
		{
			store: createSupabaseEmbeddingStore({
				client: supabase,
				ownerId: getCurrentUserId,
			}),
			embeddings: hasKey
				? {
						embed: (text) => embedWithRetry(text),
						embedBatch: async () => [],
					}
				: null,
			embedArtifactText: (row) => embedText(row),
			embedEntityRowText: (row) => embedEntityText(row),
			embedWithRetryFn: hasKey
				? (text, retryOpts) => embedWithRetry(text, retryOpts)
				: undefined,
		},
		options,
	);
}


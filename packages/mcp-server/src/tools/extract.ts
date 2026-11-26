import {
	bucketCandidates,
	createArtifactExtractTextAction,
	extractTextInput,
	extractTextSchema,
	formatArtifactExtractTextMcp,
	type ArtifactExtractTextInput,
} from "@ahkms/core";
import {
	createAnthropicTextExtractionAdapter,
	createSupabaseArtifactRepository,
	createSupabaseStorageAdapter,
	extractDocumentTextWithGemini,
	type ArtifactSupabaseClient,
	type StorageSupabaseClient,
} from "@ahkms/core/adapters";
import { getAnthropic } from "../anthropic.js";
import { embedAndStore } from "../embeddings.js";
import { env } from "../env.js";
import { getCurrentUserId } from "../identity.js";
import { supabase } from "../supabase.js";
import { generateL2Summary } from "./enrich/summary.js";

export { bucketCandidates, extractTextInput, extractTextSchema };

export async function extractTextHandler(
	args: ArtifactExtractTextInput,
): Promise<{ content: { type: "text"; text: string }[] }> {
	const action = createArtifactExtractTextAction({
		artifacts: createSupabaseArtifactRepository({
			client: supabase as unknown as ArtifactSupabaseClient,
			ownerId: getCurrentUserId,
		}),
		storage: createSupabaseStorageAdapter({
			client: supabase as unknown as StorageSupabaseClient,
			supabaseUrl: () => env.supabaseUrl,
		}),
		extraction: createAnthropicTextExtractionAdapter({
			client: () => getAnthropic(),
			model: () => env.extractModel,
			geminiApiKey: () => env.geminiApiKey,
			geminiModel: () => env.geminiExtractModel,
			provider: () =>
				process.env.KMS_EXTRACT_PROVIDER === "anthropic" ? "anthropic" : undefined,
			extractWithGemini: extractDocumentTextWithGemini,
			summarize: (text, title) => generateL2Summary(text, title),
		}),
		embedArtifact: (id, fields) => embedAndStore("artifacts", id, fields),
	});

	const result = await action.run(args, {
		caller: "mcp",
		requestId: "extract-text-handler",
	});
	return {
		content: [{ type: "text", text: formatArtifactExtractTextMcp(result) }],
	};
}

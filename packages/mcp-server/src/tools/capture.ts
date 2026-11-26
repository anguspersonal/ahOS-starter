import type { z } from "zod";
import {
	CAPTURE_DEDUP_WINDOW_MS,
	SOURCE_URL_MAX_LENGTH,
	captureInput,
	captureSchema,
	computeContentFingerprint,
	createCaptureAction,
	createCoreArtifactsPort,
	findDedupMatch,
	formatCaptureMcp,
	resolveCapturedAt,
	runCapture,
	type CaptureInput,
	type CaptureOptions,
	type CaptureResult,
	type CoreArtifactsPortDeps,
	type StoragePort,
	type StorageUploadOptions,
} from "@ahkms/core";
import {
	createSupabaseArtifactRepository,
	createSupabaseEmbeddingStore,
	createSupabaseStorageAdapter,
	type ArtifactSupabaseClient,
	type StorageSupabaseClient,
} from "@ahkms/core/adapters";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { loadCapturePreferences } from "../captureConfig.js";
import * as embeddings from "../embeddings.js";
import { env } from "../env.js";
import { getCurrentUserId } from "../identity.js";
import { supabase } from "../supabase.js";

export {
	CAPTURE_DEDUP_WINDOW_MS,
	SOURCE_URL_MAX_LENGTH,
	captureInput,
	captureSchema,
	computeContentFingerprint,
	findDedupMatch,
	formatCaptureMcp,
	resolveCapturedAt,
	runCapture,
	type CaptureInput,
	type CaptureOptions,
	type CaptureResult,
};

function createDefaultStoragePort(): StoragePort {
	const base = createSupabaseStorageAdapter({
		client: supabase as unknown as StorageSupabaseClient,
		supabaseUrl: () => env.supabaseUrl,
	});
	return {
		...base,
		async upload(
			bucket: string,
			path: string,
			body: string | Uint8Array,
			options: StorageUploadOptions & { upsert?: boolean },
		): Promise<void> {
			const { error } = await supabase.storage.from(bucket).upload(path, body, {
				contentType: options.contentType,
				upsert: Boolean(options.upsert),
			});
			if (error) throw new Error(error.message);
		},
	};
}

export const serverArtifactsDeps: CoreArtifactsPortDeps = {
	ownerId: getCurrentUserId,
	storageBucket: () => env.storageBucket,
	config: { loadCapturePreferences: () => loadCapturePreferences() },
	storage: createDefaultStoragePort(),
	artifacts: (userId) =>
		createSupabaseArtifactRepository({
			client: {
				from: (table: string) => supabase.from(table),
				rpc: (fn: string, args?: Record<string, unknown>) => supabase.rpc(fn, args),
			} as unknown as ArtifactSupabaseClient,
			ownerId: () => userId ?? getCurrentUserId(),
		}),
	embedding: () =>
		"mock" in embeddings.embedAndStore
			? { embed: async () => [0], embedBatch: async () => [[0]] }
			: typeof embeddings.embed === "function" &&
				  Boolean(env.geminiApiKey?.trim() || env.openaiApiKey?.trim())
				? { embed: embeddings.embed, embedBatch: embeddings.embedBatch }
				: null,
	embeddingStore: (input) =>
		"mock" in embeddings.embedAndStore
			? {
					setEmbedding: async (table, id) => {
						await embeddings.embedAndStore(table, id, {
							title: input.title,
							plain_text: input.text,
						});
					},
				}
			: createSupabaseEmbeddingStore(supabase),
	onEmbedError: (err) => {
		process.stderr.write(`[embedAndStore] artifacts: ${String(err)}\n`);
	},
};

export async function captureCore(
	args: z.infer<typeof captureSchema>,
	injectedUserId?: string,
	options?: CaptureOptions,
): Promise<CaptureResult> {
	return createCoreArtifactsPort(serverArtifactsDeps).capture(args, injectedUserId, options);
}

export const captureAction = createCaptureAction({ capture: captureCore });

export async function captureHandler(
	args: z.infer<typeof captureSchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	return toMcpTool(captureAction).handler(args);
}

import { AdapterUnavailableError } from "../buildRegistry.js";
import type { CaptureInput } from "../domain/capture.js";
import type { ArtifactRepository, ArtifactsPort } from "../../ports/artifacts.js";
import type { ConfigRepository } from "../../ports/config.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type { StoragePort } from "../../ports/storage.js";
import { runCapture } from "./captureBody.js";
import { documentDuplicatesCore } from "./documentDuplicatesBody.js";

export type CoreArtifactsRepository = Partial<
	Pick<
		ArtifactRepository,
		"insert" | "findOldestByDedupKey" | "findOldestByFingerprint" | "patch" | "duplicateClusters"
	>
>;

export interface CoreArtifactsPortDeps {
	artifacts?: CoreArtifactsRepository | ((userId?: string) => CoreArtifactsRepository);
	storage?: Pick<StoragePort, "upload" | "remove" | "publicUrl">;
	config?: Pick<ConfigRepository, "loadCapturePreferences">;
	embedding?: EmbeddingPort | null | (() => EmbeddingPort | null | undefined);
	embeddings?: EmbeddingPort | null | (() => EmbeddingPort | null | undefined);
	embeddingStore?: EmbeddingStorePort | ((input: CaptureInput) => EmbeddingStorePort | undefined);
	storageBucket?: string | (() => string);
	ownerId?: string | (() => string);
	now?: () => Date;
	onEmbedError?: (err: unknown) => void;
}

export function createCoreArtifactsPort(deps: CoreArtifactsPortDeps = {}): ArtifactsPort {
	const resolveOwner = (userId?: string) =>
		userId ?? (typeof deps.ownerId === "function" ? deps.ownerId() : deps.ownerId);
	const resolveArtifacts = (userId?: string) =>
		typeof deps.artifacts === "function" ? deps.artifacts(userId) : deps.artifacts;

	return {
		capture: async (input, userId, options) => {
			const artifacts = resolveArtifacts(userId);
			if (
				!artifacts?.insert ||
				!artifacts.findOldestByDedupKey ||
				!artifacts.findOldestByFingerprint ||
				!deps.storage ||
				!deps.config
			) {
				throw new AdapterUnavailableError("artifacts adapter is not wired in this process");
			}
			const rawEmbed = "embeddings" in deps ? deps.embeddings : deps.embedding;
			return runCapture(
				{
					artifacts: {
						insert: artifacts.insert.bind(artifacts),
						findOldestByDedupKey: artifacts.findOldestByDedupKey.bind(artifacts),
						findOldestByFingerprint: artifacts.findOldestByFingerprint.bind(artifacts),
						...(artifacts.patch ? { patch: artifacts.patch.bind(artifacts) } : {}),
					},
					storage: deps.storage,
					config: deps.config,
					embeddings: typeof rawEmbed === "function" ? rawEmbed() : rawEmbed,
					embeddingStore:
						typeof deps.embeddingStore === "function"
							? deps.embeddingStore(input)
							: deps.embeddingStore,
					storageBucket: deps.storageBucket,
					ownerId: deps.ownerId,
					now: deps.now,
					onEmbedError: deps.onEmbedError,
				},
				input,
				userId,
				options,
			);
		},
		documentDuplicates: async (input, userId) => {
			const effectiveUserId = resolveOwner(userId);
			const artifacts = resolveArtifacts(effectiveUserId);
			if (!artifacts?.duplicateClusters) {
				throw new AdapterUnavailableError("artifacts adapter is not wired in this process");
			}
			return documentDuplicatesCore(
				{ duplicateClusters: artifacts.duplicateClusters.bind(artifacts) },
				input,
				effectiveUserId,
			);
		},
	};
}

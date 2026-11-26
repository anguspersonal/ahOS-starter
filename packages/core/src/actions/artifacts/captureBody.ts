import {
	ARTIFACT_SURFACES,
	deriveArtifactTitle,
	slugify,
} from "../../domain/artifacts.js";
import {
	applyCaptureRouting,
	DEFAULT_CAPTURE_PREFERENCES,
	type CapturePreferences,
} from "../../domain/capturePreferences.js";
import { embedAndStore } from "../../domain/embeddings.js";
import {
	BACKDATABLE_CONTENT_SUBTYPES,
	DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
	SYSTEM_PRODUCED_CONTENT_SUBTYPES,
} from "../../domain/vocab.js";
import {
	type ArtifactRepository,
	type CaptureOptions,
	type CaptureResult,
	type DedupMatch,
} from "../../ports/artifacts.js";
import type { ConfigRepository } from "../../ports/config.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type { StoragePort, StorageUploadOptions } from "../../ports/storage.js";
import {
	SOURCE_URL_MAX_LENGTH,
	type CaptureInput,
} from "../domain/capture.js";

const PG_UNIQUE_VIOLATION = "23505";

export const CAPTURE_DEDUP_WINDOW_MS = 2 * 60 * 1000;
export { SOURCE_URL_MAX_LENGTH };

function normalizeForFingerprint(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function computeContentFingerprint(input: {
	title: string;
	text: string;
	contentSubtype: string | undefined;
	surface: string;
	sourceChannel: string;
	tags: string[];
}): Promise<string> {
	const normalized = [
		normalizeForFingerprint(input.title),
		normalizeForFingerprint(input.text),
		input.contentSubtype ?? "",
		input.surface,
		input.sourceChannel,
		[...input.tags].sort().join(","),
	].join("\u0000");
	const bytes = new TextEncoder().encode(normalized);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function findDedupMatch(
	artifacts: Pick<
		ArtifactRepository,
		"findOldestByDedupKey" | "findOldestByFingerprint"
	>,
	dedupKey: string | undefined,
	contentFingerprint: string,
	contentSubtype: string | undefined,
	now: Date = new Date(),
): Promise<DedupMatch | null> {
	try {
		if (dedupKey) {
			return await artifacts.findOldestByDedupKey(dedupKey);
		}
		if (contentSubtype && SYSTEM_PRODUCED_CONTENT_SUBTYPES.has(contentSubtype)) {
			return null;
		}
		const windowStart = new Date(
			now.getTime() - CAPTURE_DEDUP_WINDOW_MS,
		).toISOString();
		return await artifacts.findOldestByFingerprint(
			contentFingerprint,
			windowStart,
		);
	} catch {
		return null;
	}
}

export function resolveCapturedAt(
	declared: string | undefined,
	contentSubtype: string | undefined,
	now: Date = new Date(),
): string {
	if (declared === undefined) return now.toISOString();

	if (!contentSubtype || !BACKDATABLE_CONTENT_SUBTYPES.has(contentSubtype)) {
		throw new Error(
			`captured_at may only be declared for content_subtype in [${[...BACKDATABLE_CONTENT_SUBTYPES].join(", ")}]; got ${contentSubtype ? `'${contentSubtype}'` : "none"}. Nothing was captured. Capture is dumb and stamps now; the allowlist exists so one caller declaring the day its own artifact is about cannot become a general backdating dial (#414, #562).`,
		);
	}

	const parsed = Date.parse(declared);
	if (Number.isNaN(parsed)) {
		throw new Error(
			`captured_at '${declared}' is not a parseable date. Use an ISO timestamp ('2026-08-17T00:00:00Z') or 'YYYY-MM-DD'. Nothing was captured.`,
		);
	}
	if (parsed > now.getTime()) {
		throw new Error(
			`captured_at '${declared}' is in the future (now is ${now.toISOString()}). Nothing was captured. An artifact filed under a day that has not happened is invisible to every day-window read until that day arrives, and then arrives as history nobody wrote.`,
		);
	}

	return new Date(parsed).toISOString();
}

export interface CaptureBodyDeps {
	artifacts: Pick<
		ArtifactRepository,
		"insert" | "findOldestByDedupKey" | "findOldestByFingerprint"
	> &
		Partial<Pick<ArtifactRepository, "patch">>;
	storage: Pick<StoragePort, "upload" | "remove" | "publicUrl">;
	config: Pick<ConfigRepository, "loadCapturePreferences">;
	embeddings?: EmbeddingPort | null;
	embeddingStore?: EmbeddingStorePort;
	storageBucket?: string | (() => string);
	ownerId?: string | (() => string);
	now?: () => Date;
	onEmbedError?: (err: unknown) => void;
}

const noopEmbeddingStore: EmbeddingStorePort = {
	setEmbedding: async () => {},
};

function resolveString(val: string | (() => string) | undefined, fallback: string): string {
	if (!val) return fallback;
	return typeof val === "function" ? val() : val;
}

export async function runCapture(
	deps: CaptureBodyDeps,
	args: CaptureInput,
	injectedUserId?: string,
	options?: CaptureOptions,
): Promise<CaptureResult> {
	const now = deps.now ? deps.now() : new Date();
	const capturedAt = resolveCapturedAt(args.captured_at, args.content_subtype, now);
	const title = deriveArtifactTitle({ explicitTitle: args.title, text: args.text })!;
	const userId = injectedUserId ?? resolveString(deps.ownerId, "");
	const bucket = resolveString(deps.storageBucket, "artifacts");

	const loadedPrefs = await deps.config.loadCapturePreferences?.();
	const prefs: CapturePreferences = loadedPrefs
		? { ...DEFAULT_CAPTURE_PREFERENCES, ...loadedPrefs }
		: DEFAULT_CAPTURE_PREFERENCES;
	const routing = applyCaptureRouting(prefs, {
		text: args.text,
		title,
		source_url: args.source_url,
		tags: args.tags,
	});
	const resolvedSurface =
		args.surface ?? prefs.default_surface ?? ARTIFACT_SURFACES.api;
	const contentFingerprint = await computeContentFingerprint({
		title,
		text: args.text,
		contentSubtype: args.content_subtype,
		surface: resolvedSurface,
		sourceChannel: routing.source_channel,
		tags: routing.tags,
	});

	const dedupMatch = await findDedupMatch(
		deps.artifacts,
		args.dedup_key,
		contentFingerprint,
		args.content_subtype,
		now,
	);
	if (dedupMatch) {
		const shouldUpdateOnDedupKey =
			Boolean(options?.updateOnDedupKey) ||
			args.content_subtype === DAILY_EMAIL_FLOW_CONTENT_SUBTYPE;
		if (shouldUpdateOnDedupKey && args.dedup_key && deps.artifacts.patch) {
			const existingMsgIds = Array.isArray(
				dedupMatch.processing_metadata?.whatsapp_message_ids,
			)
				? (dedupMatch.processing_metadata.whatsapp_message_ids as unknown[]).map(String)
				: null;
			const incomingMsgIds = Array.isArray(args.processing_metadata?.whatsapp_message_ids)
				? (args.processing_metadata.whatsapp_message_ids as unknown[]).map(String)
				: null;
			const allMsgIdsPresent =
				existingMsgIds !== null &&
				incomingMsgIds !== null &&
				incomingMsgIds.length <= existingMsgIds.length &&
				incomingMsgIds.every((id) => existingMsgIds.includes(id));
			const isUnchanged =
				allMsgIdsPresent || dedupMatch.content_fingerprint === contentFingerprint;

			if (!isUnchanged) {
				const targetBucket = dedupMatch.storage_bucket || bucket;
				try {
					await deps.storage.upload(
						targetBucket,
						dedupMatch.storage_path,
						args.text,
						{ contentType: "text/markdown", upsert: true } as StorageUploadOptions,
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					throw new Error(`Storage update failed: ${msg}`);
				}

				const prevMeta =
					dedupMatch.processing_metadata &&
					typeof dedupMatch.processing_metadata === "object"
						? { ...dedupMatch.processing_metadata }
						: {};
				delete prevMeta.derivation;
				const mergedMsgIds =
					existingMsgIds && incomingMsgIds
						? Array.from(new Set([...existingMsgIds, ...incomingMsgIds]))
						: incomingMsgIds;
				const nextMetadata: Record<string, unknown> = {
					...prevMeta,
					...(args.processing_metadata ?? {}),
					...(mergedMsgIds ? { whatsapp_message_ids: mergedMsgIds } : {}),
				};

				try {
					await deps.artifacts.patch(dedupMatch.id, {
						title,
						plain_text: args.text,
						file_size: new TextEncoder().encode(args.text).length,
						tags: routing.tags,
						content_fingerprint: contentFingerprint,
						processing_metadata: nextMetadata,
						embedding: null,
						updated_at: (deps.now ? deps.now() : new Date()).toISOString(),
					});
				} catch (err) {
					const raw = err instanceof Error ? err.message : String(err);
					const msg = raw.replace(/^Artifact update failed:\s*/, "");
					throw new Error(`Update failed: ${msg}`);
				}

				await embedAndStore(
					deps.embeddings,
					deps.embeddingStore ?? noopEmbeddingStore,
					"artifacts",
					dedupMatch.id,
					{ title, plain_text: args.text },
					{ onError: deps.onEmbedError },
				);

				return {
					id: dedupMatch.id,
					title,
					tags: routing.tags,
					source_channel: dedupMatch.source_channel,
					storage_bucket: targetBucket,
					storage_path: dedupMatch.storage_path,
					captured_at: dedupMatch.captured_at,
					captured_at_declared: Boolean(args.captured_at),
					deduplicated: false,
					updated: true,
				};
			}
		}

		return {
			id: dedupMatch.id,
			title: dedupMatch.title,
			tags: dedupMatch.tags ?? [],
			source_channel: dedupMatch.source_channel,
			storage_bucket: dedupMatch.storage_bucket,
			storage_path: dedupMatch.storage_path,
			captured_at: dedupMatch.captured_at,
			captured_at_declared: Boolean(args.captured_at),
			deduplicated: true,
		};
	}

	const id = globalThis.crypto.randomUUID();
	const filename = `${slugify(title)}-${id.slice(0, 8)}.md`;
	const storagePath = `notes/${userId}/${id}.md`;

	try {
		await deps.storage.upload(bucket, storagePath, args.text, {
			contentType: "text/markdown",
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Storage upload failed: ${msg}`);
	}

	let data: { id: string; title: string; created_at: string };
	try {
		data = await deps.artifacts.insert({
			id,
			user_id: userId,
			storage_bucket: bucket,
			storage_path: storagePath,
			storage_url: deps.storage.publicUrl(bucket, storagePath),
			filename,
			original_file_name: filename,
			file_type: "text/markdown",
			content_type: "text/markdown",
			file_extension: "md",
			file_size: new TextEncoder().encode(args.text).length,
			artifact_type: "original",
			captured_at: capturedAt,
			source: args.source_url ?? routing.source_channel,
			source_url: args.source_url ?? null,
			source_channel: routing.source_channel,
			surface: args.surface ?? prefs.default_surface ?? ARTIFACT_SURFACES.api,
			trust_override: args.trust_override ?? null,
			captured_by: args.captured_by ?? null,
			lifecycle_stage: "uploaded",
			processing_status: "pending",
			title,
			plain_text: args.text,
			tags: routing.tags,
			content_subtype: args.content_subtype ?? null,
			urgency: args.urgency ?? null,
			processing_metadata: {
				...(args.processing_metadata ?? {}),
				derivation: args.processing_metadata?.derivation ?? { status: "pending" },
			},
			dedup_key: args.dedup_key ?? null,
			content_fingerprint: contentFingerprint,
		});
	} catch (err) {
		try {
			await deps.storage.remove(bucket, [storagePath]);
		} catch {
			// Best-effort cleanup so a failed insert does not orphan the storage object.
		}

		if (
			args.dedup_key &&
			(err as { code?: string } | null)?.code === PG_UNIQUE_VIOLATION
		) {
			const winner = await findDedupMatch(
				deps.artifacts,
				args.dedup_key,
				contentFingerprint,
				args.content_subtype,
				deps.now ? deps.now() : new Date(),
			);
			if (winner) {
				return {
					id: winner.id,
					title: winner.title,
					tags: winner.tags ?? [],
					source_channel: winner.source_channel,
					storage_bucket: winner.storage_bucket,
					storage_path: winner.storage_path,
					captured_at: winner.captured_at,
					captured_at_declared: Boolean(args.captured_at),
					deduplicated: true,
				};
			}
		}

		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Insert failed: ${msg}`);
	}

	await embedAndStore(
		deps.embeddings,
		deps.embeddingStore ?? noopEmbeddingStore,
		"artifacts",
		id,
		{ title, plain_text: args.text },
		{ onError: deps.onEmbedError },
	);

	return {
		id: data.id,
		title: data.title,
		tags: routing.tags,
		source_channel: routing.source_channel,
		storage_bucket: bucket,
		storage_path: storagePath,
		captured_at: capturedAt,
		captured_at_declared: Boolean(args.captured_at),
		deduplicated: false,
	};
}

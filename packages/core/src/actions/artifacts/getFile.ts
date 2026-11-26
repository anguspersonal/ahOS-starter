import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { ArtifactRow } from "../../ports/artifacts.js";
import {
	SIGNED_URL_TTL_SECONDS,
	bucketCandidates,
	signedUrlFromAnyBucket,
	type StoragePort,
} from "../../ports/storage.js";
import {
	getArtifactInput,
	getArtifactSchema,
	loadArtifactFromPorts,
	type ArtifactGetPorts,
	type ArtifactGetResult,
} from "./get.js";

export const getArtifactAndFileInput = getArtifactInput;
export const getArtifactAndFileSchema = z.object(getArtifactAndFileInput);
export type ArtifactGetFileInput = z.input<typeof getArtifactAndFileSchema>;

export type ArtifactGetFileResult =
	| { found: false; text: string }
	| { found: true; artifact: ArtifactRow; fileLine: string; text: string };

export interface ArtifactGetFilePorts extends ArtifactGetPorts {
	storage: Pick<StoragePort, "signedUrl">;
}

// Content we can store directly as searchable `plain_text`. Binary (PDF/image/…)
// is stored as-is and left for artifact_extract_text to transcribe.
export function isTextual(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml"
	);
}

/**
 * Resolve a file reference for an artifact, if one exists. Three cases (#588, #1610):
 *
 * 1. Discovered pointers (discover.ts) stamp `storage_bucket='external'` — the row's
 *    `storage_url` is an EXTERNAL link (Notion page, Drive webViewLink, a
 *    `discovered://...` locator when the source gave none), never a Supabase Storage
 *    object. Minting a signed URL for it would just 404, so this is surfaced as its own
 *    "external pointer" case with the link as-is, not a signed URL and not a null.
 * 2. Text captures (capture.ts, createTask.ts's task-request provenance, createEvent.ts)
 *    persist their own body as the stored object so the artifacts row's NOT NULL
 *    storage_* columns are honest — but that object is just a serialization of the same
 *    text already in `plain_text` above, not a separate "attached photo/file" the way the
 *    issue means it (image, PDF, ...). `file_type` is how capture marks that
 *    ('text/markdown' etc, same test `artifact_extract_text` uses to skip the vision call). No
 *    separate file reference is returned for these — cleanly, not an error.
 * 3. Everything else (drive_import_file, ingest_drive — real binaries) has a real object
 *    at `storage_path` in a real bucket: mint a short-lived signed URL.
 */
export async function resolveFileReference(
	artifact: ArtifactRow,
	storage: Pick<StoragePort, "signedUrl">,
): Promise<string> {
	if (artifact.storage_bucket === "external") {
		return `File: external link only (storage_url is not a Supabase Storage object) — ${artifact.storage_url}`;
	}

	if (isTextual(artifact.file_type ?? "")) {
		return "File: none (text capture — its content is the plain_text above, not a separate attached file).";
	}

	// bucketCandidates always includes the known real buckets, so this list is never empty.
	const buckets = bucketCandidates(artifact.storage_bucket, artifact.storage_url);
	const result = await signedUrlFromAnyBucket(
		storage,
		buckets,
		artifact.storage_path,
		SIGNED_URL_TTL_SECONDS,
	);
	if ("error" in result) {
		return `File: unavailable — signed URL failed for "${artifact.storage_path}" (tried [${buckets.join(", ")}]): ${result.error}`;
	}

	return `File: ${result.url} (signed, bucket=${result.bucket}, expires in ${SIGNED_URL_TTL_SECONDS}s)`;
}

export function createArtifactGetFileAction(
	ports: ArtifactGetFilePorts,
): ActionDefinition<typeof getArtifactAndFileSchema, ArtifactGetFileResult> {
	return defineAction({
		id: "artifact_get_file",
		domain: "artifacts",
		description:
			"artifact_get plus a resolvable reference to the artifact's original file, when one exists. Three " +
			"outcomes: a real stored file returns a reference; a plain-text capture has no file and says so " +
			"cleanly; a missing file is reported as missing rather than as an error. Full notes: " +
			"docs/guides/tools/artifact_get_file.md",
		schema: getArtifactAndFileSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<ArtifactGetFileResult> => {
			const result: ArtifactGetResult = await loadArtifactFromPorts(args.id, ports);
			if (!result.found) {
				return result;
			}
			const fileLine = await resolveFileReference(result.artifact, ports.storage);
			return {
				found: true,
				artifact: result.artifact,
				fileLine,
				text: `${result.text}\n\n${fileLine}`,
			};
		},
		formatMcp: (output) => output.text,
	});
}

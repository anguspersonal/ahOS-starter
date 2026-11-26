import { env } from "../env.js";

// Shared knowledge-store helpers used by both `capture` (text notes) and
// `ingest_drive` (Drive → artifact). Keeping them in one place means the
// two capture paths agree on storage paths and URL shape.

export { slugify } from "@ahkms/core";

// Mirror the worker's buildStorageUrl (packages/worker/src/workflows/steps/createArtifact.ts):
// the frontend uses storage_url directly as <img src> / <a href>, so it must be a real URL.
export function buildStorageUrl(bucket: string, objectPath: string): string {
	return `${env.supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
}

// Content we can store directly as searchable `plain_text`. Binary (PDF/image/…)
// is stored as-is and left for artifact_extract_text to transcribe. Shared by
// drive_import_file and ingest_enrich_next so both decide "is this text?" identically.
export function isTextual(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml"
	);
}

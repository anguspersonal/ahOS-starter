/**
 * Port and pure bucket-fallback helpers for object storage (ADR-101 §1, #1610).
 * Pure types and helpers only — no external SDKs or environment dependencies.
 */

// Buckets that actually exist in this project. Legacy `artifacts.storage_bucket`
// is unreliable (~44% of rows name a bucket the file isn't in : e.g. "inputs",
// which doesn't exist), so we never trust it alone.
export const KNOWN_BUCKETS = ["user-uploads", "raw-inputs", "derived-artifacts"] as const;

// Short-lived on purpose (#588): the URL is meant to be resolved by the caller
// immediately (e.g. handed straight to a vision model), not cached/persisted.
export const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Ordered, de-duped list of buckets to try. `storage_url` embeds the real bucket
 * (`/object/public/<bucket>/<path>`) and is the most reliable signal; `storage_bucket`
 * is next; then we sweep the known buckets to cover stale/missing data (#588, #1610).
 */
export function bucketCandidates(
	storageBucket: string | null,
	storageUrl: string | null,
): string[] {
	const fromUrl =
		storageUrl?.match(/\/object\/(?:public|sign|authenticated)\/([^/?]+)\//)?.[1] ?? null;
	const ordered = [fromUrl, storageBucket, ...KNOWN_BUCKETS].filter(
		(b): b is string => Boolean(b),
	);
	return [...new Set(ordered)];
}

export interface StorageUploadOptions {
	contentType: string;
}

export interface StoragePort {
	signedUrl(bucket: string, path: string, ttl: number): Promise<string>;
	download(bucket: string, path: string): Promise<Uint8Array>;
	upload(
		bucket: string,
		path: string,
		body: string | Uint8Array,
		options: StorageUploadOptions,
	): Promise<void>;
	remove(bucket: string, paths: string[]): Promise<void>;
	publicUrl(bucket: string, path: string): string;
}


/**
 * Mint a Storage signed URL for `path`, trying each candidate bucket in turn — mirrors
 * `downloadFromAnyBucket`, since `artifacts.storage_bucket` is ~44%-unreliable (#588, #1610).
 */
export async function signedUrlFromAnyBucket(
	storage: Pick<StoragePort, "signedUrl">,
	buckets: string[],
	path: string,
	ttl: number = SIGNED_URL_TTL_SECONDS,
): Promise<{ url: string; bucket: string } | { error: string }> {
	const errors: string[] = [];
	for (const bucket of buckets) {
		try {
			const url = await storage.signedUrl(bucket, path, ttl);
			if (url) return { url, bucket };
			errors.push(`${bucket}: no data`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${bucket}: ${message}`);
		}
	}
	return { error: errors.join("; ") };
}

/**
 * Download an object by path, trying each candidate bucket until one succeeds.
 * Throws a diagnostic listing every bucket tried if none has the file (#1610).
 */
export async function downloadFromAnyBucket(
	storage: Pick<StoragePort, "download">,
	buckets: string[],
	path: string,
): Promise<Uint8Array> {
	const errors: string[] = [];
	for (const bucket of buckets) {
		try {
			return await storage.download(bucket, path);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${bucket}: ${message}`);
		}
	}
	throw new Error(
		`Download failed for "${path}" : tried buckets [${buckets.join(", ")}]. ${errors.join("; ")}`,
	);
}

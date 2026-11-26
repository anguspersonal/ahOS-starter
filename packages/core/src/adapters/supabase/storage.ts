import type { SupabaseClient } from "@supabase/supabase-js";
import {
	KNOWN_BUCKETS,
	SIGNED_URL_TTL_SECONDS,
	bucketCandidates,
	downloadFromAnyBucket,
	signedUrlFromAnyBucket,
	type StoragePort,
	type StorageUploadOptions,
} from "../../ports/storage.js";

export {
	KNOWN_BUCKETS,
	SIGNED_URL_TTL_SECONDS,
	bucketCandidates,
	downloadFromAnyBucket,
	signedUrlFromAnyBucket,
	type StoragePort,
	type StorageUploadOptions,
};

export type StorageSupabaseClient = Pick<SupabaseClient, "storage">;

export interface SupabaseStorageAdapterOptions {
	client: StorageSupabaseClient;
	supabaseUrl?: string | (() => string);
}

export function createSupabaseStorageAdapter(
	clientOrOptions: StorageSupabaseClient | SupabaseStorageAdapterOptions,
): StoragePort {
	const getClient = (): StorageSupabaseClient =>
		"storage" in clientOrOptions ? clientOrOptions : clientOrOptions.client;

	const resolveSupabaseUrl = (): string => {
		if ("storage" in clientOrOptions || !clientOrOptions.supabaseUrl) {
			return "";
		}
		const url =
			typeof clientOrOptions.supabaseUrl === "function"
				? clientOrOptions.supabaseUrl()
				: clientOrOptions.supabaseUrl;
		return url.replace(/\/+$/, "");
	};

	return {
		async signedUrl(bucket: string, path: string, ttl: number): Promise<string> {
			const { data, error } = await getClient()
				.storage.from(bucket)
				.createSignedUrl(path, ttl);
			if (data?.signedUrl) return data.signedUrl;
			throw new Error(error?.message ?? "no data");
		},

		async download(bucket: string, path: string): Promise<Uint8Array> {
			const { data, error } = await getClient()
				.storage.from(bucket)
				.download(path);
			if (data) return new Uint8Array(await data.arrayBuffer());
			throw new Error(error?.message ?? "no data");
		},

		async upload(
			bucket: string,
			path: string,
			body: string | Uint8Array,
			options: StorageUploadOptions,
		): Promise<void> {
			const { error } = await getClient()
				.storage.from(bucket)
				.upload(path, body, {
					contentType: options.contentType,
					upsert: false,
				});
			if (error) {
				throw new Error(error.message);
			}
		},

		async remove(bucket: string, paths: string[]): Promise<void> {
			const res = await getClient().storage.from(bucket).remove(paths);
			if (res?.error) {
				throw new Error(res.error.message);
			}
		},

		publicUrl(bucket: string, path: string): string {
			return `${resolveSupabaseUrl()}/storage/v1/object/public/${bucket}/${path}`;
		},
	};
}

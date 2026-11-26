import { describe, expect, it, vi } from "vitest";
import {
	KNOWN_BUCKETS,
	bucketCandidates,
	createSupabaseStorageAdapter,
	downloadFromAnyBucket,
	signedUrlFromAnyBucket,
	type StorageSupabaseClient,
} from "./storage.js";

describe("bucketCandidates (#1610)", () => {
	it("prefers bucket extracted from storage_url, then storage_bucket, then KNOWN_BUCKETS without duplicates", () => {
		expect(
			bucketCandidates(
				"inputs",
				"https://x.supabase.co/storage/v1/object/public/raw-inputs/drive/file.pdf",
			),
		).toEqual(["raw-inputs", "inputs", "user-uploads", "derived-artifacts"]);
	});

	it("extracts bucket from sign and authenticated storage URLs and handles null inputs", () => {
		expect(
			bucketCandidates(
				null,
				"https://x.supabase.co/storage/v1/object/sign/derived-artifacts/a/b.png?token=1",
			),
		).toEqual(["derived-artifacts", "user-uploads", "raw-inputs"]);

		expect(bucketCandidates(null, null)).toEqual([...KNOWN_BUCKETS]);
	});
});

describe("createSupabaseStorageAdapter (#1610)", () => {
	it("signedUrl delegates to storage.from(bucket).createSignedUrl(path, ttl) and throws on error or missing data", async () => {
		const createSignedUrl = vi
			.fn()
			.mockResolvedValueOnce({
				data: { signedUrl: "https://signed.example/user-uploads/a.pdf" },
				error: null,
			})
			.mockResolvedValueOnce({
				data: null,
				error: { message: "Object not found" },
			})
			.mockResolvedValueOnce({
				data: null,
				error: null,
			});
		const from = vi.fn(() => ({ createSignedUrl }));
		const adapter = createSupabaseStorageAdapter({
			client: { storage: { from } } as unknown as StorageSupabaseClient,
		});

		await expect(adapter.signedUrl("user-uploads", "a.pdf", 3600)).resolves.toBe(
			"https://signed.example/user-uploads/a.pdf",
		);
		expect(from).toHaveBeenCalledWith("user-uploads");
		expect(createSignedUrl).toHaveBeenCalledWith("a.pdf", 3600);

		await expect(adapter.signedUrl("user-uploads", "missing.pdf", 3600)).rejects.toThrow(
			"Object not found",
		);
		await expect(adapter.signedUrl("user-uploads", "empty.pdf", 3600)).rejects.toThrow(
			"no data",
		);
	});

	it("download delegates to storage.from(bucket).download(path) and returns Uint8Array", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const download = vi
			.fn()
			.mockResolvedValueOnce({
				data: new Blob([bytes]),
				error: null,
			})
			.mockResolvedValueOnce({
				data: null,
				error: { message: "bucket missing" },
			});
		const from = vi.fn(() => ({ download }));
		const adapter = createSupabaseStorageAdapter({
			storage: { from },
		} as unknown as StorageSupabaseClient);

		const result = await adapter.download("raw-inputs", "doc.bin");
		expect(Array.from(result)).toEqual([1, 2, 3, 4]);
		expect(from).toHaveBeenCalledWith("raw-inputs");
		expect(download).toHaveBeenCalledWith("doc.bin");

		await expect(adapter.download("raw-inputs", "missing.bin")).rejects.toThrow(
			"bucket missing",
		);
	});

	it("signedUrlFromAnyBucket falls back across candidate buckets and reports all errors when none match", async () => {
		const adapter = createSupabaseStorageAdapter({
			storage: {
				from: (bucket: string) => ({
					createSignedUrl: async (path: string, ttl: number) => {
						if (bucket === "raw-inputs") {
							return {
								data: { signedUrl: `https://signed.example/${bucket}/${path}?ttl=${ttl}` },
								error: null,
							};
						}
						return { data: null, error: { message: "not found" } };
					},
				}),
			},
		} as unknown as StorageSupabaseClient);

		const hit = await signedUrlFromAnyBucket(
			adapter,
			["inputs", "raw-inputs", "user-uploads"],
			"folder/file.pdf",
			3600,
		);
		expect(hit).toEqual({
			url: "https://signed.example/raw-inputs/folder/file.pdf?ttl=3600",
			bucket: "raw-inputs",
		});

		const miss = await signedUrlFromAnyBucket(
			adapter,
			["inputs", "user-uploads"],
			"folder/file.pdf",
			3600,
		);
		expect(miss).toEqual({
			error: "inputs: not found; user-uploads: not found",
		});
	});

	it("downloadFromAnyBucket returns bytes from first matching bucket and throws listing all tried buckets on failure", async () => {
		const adapter = createSupabaseStorageAdapter({
			storage: {
				from: (bucket: string) => ({
					download: async () => {
						if (bucket === "derived-artifacts") {
							return { data: new Blob(["hello"]), error: null };
						}
						return { data: null, error: { message: "404" } };
					},
				}),
			},
		} as unknown as StorageSupabaseClient);

		const bytes = await downloadFromAnyBucket(
			adapter,
			["user-uploads", "derived-artifacts"],
			"notes/hello.txt",
		);
		expect(new TextDecoder().decode(bytes)).toBe("hello");

		await expect(
			downloadFromAnyBucket(adapter, ["inputs", "user-uploads"], "notes/missing.txt"),
		).rejects.toThrow(
			'Download failed for "notes/missing.txt" : tried buckets [inputs, user-uploads]. inputs: 404; user-uploads: 404',
		);
	});
});

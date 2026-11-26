import { describe, expect, it, vi } from "vitest";
import {
	createSupabaseStorageAdapter,
	type StorageSupabaseClient,
} from "./storage.js";

describe("createSupabaseStorageAdapter write & URL helpers (#1611)", () => {
	it("upload calls storage.from(bucket).upload(path, body, { contentType, upsert: false }) and rejects on error", async () => {
		const upload = vi
			.fn()
			.mockResolvedValueOnce({ data: { path: "p/a.md" }, error: null })
			.mockResolvedValueOnce({
				data: null,
				error: { message: "Bucket quota exceeded" },
			});
		const from = vi.fn().mockReturnValue({ upload });

		const adapter = createSupabaseStorageAdapter({
			client: { storage: { from } } as unknown as StorageSupabaseClient,
			supabaseUrl: "https://example.supabase.co",
		});

		await adapter.upload("user-uploads", "p/a.md", "body", {
			contentType: "text/markdown",
		});

		expect(from).toHaveBeenCalledWith("user-uploads");
		expect(upload).toHaveBeenCalledWith("p/a.md", "body", {
			contentType: "text/markdown",
			upsert: false,
		});

		await expect(
			adapter.upload("user-uploads", "p/a.md", "body", {
				contentType: "text/markdown",
			}),
		).rejects.toThrow("Bucket quota exceeded");
	});

	it("remove calls storage.from(bucket).remove(paths)", async () => {
		const remove = vi.fn().mockResolvedValue({ data: [], error: null });
		const from = vi.fn().mockReturnValue({ remove });

		const adapter = createSupabaseStorageAdapter({
			client: { storage: { from } } as unknown as StorageSupabaseClient,
			supabaseUrl: "https://example.supabase.co",
		});

		await adapter.remove("user-uploads", ["p/a.md"]);
		expect(from).toHaveBeenCalledWith("user-uploads");
		expect(remove).toHaveBeenCalledWith(["p/a.md"]);
	});

	it("publicUrl builds the public storage URL from supabaseUrl", () => {
		const adapter = createSupabaseStorageAdapter({
			client: { storage: { from: vi.fn() } } as unknown as StorageSupabaseClient,
			supabaseUrl: "https://example.supabase.co",
		});

		expect(adapter.publicUrl("user-uploads", "p/a.md")).toBe(
			"https://example.supabase.co/storage/v1/object/public/user-uploads/p/a.md",
		);
	});
});

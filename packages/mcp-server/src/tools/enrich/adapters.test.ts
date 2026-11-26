import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadItemBytes = vi.fn();
const createOneDriveAdapter = vi.fn((..._args: unknown[]) => ({
	downloadItemBytes: (...args: unknown[]) => downloadItemBytes(...args),
}));

vi.mock("@ahkms/core/adapters", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ahkms/core/adapters")>();
	return {
		...actual,
		createOneDriveAdapter: (...args: unknown[]) => createOneDriveAdapter(...args),
	};
});

const { getReadAdapter, supportedConnectors } = await import("./adapters.js");

describe("onedrive read adapter (#2085)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers 'onedrive' in supportedConnectors and getReadAdapter", () => {
		expect(supportedConnectors()).toContain("onedrive");
		expect(getReadAdapter("onedrive")).toBeDefined();
		expect(getReadAdapter("onedrive")?.connector).toBe("onedrive");
	});

	it("downloads OneDrive item bytes and maps extension, hash, and sourceName", async () => {
		downloadItemBytes.mockResolvedValue({
			item: {
				id: "od-item-1",
				name: "Budget_2026.xlsx",
				size: 4,
				webUrl: "https://onedrive.live.com/view?id=od-item-1",
				createdDateTime: "2026-01-01T00:00:00Z",
				lastModifiedDateTime: "2026-02-01T00:00:00Z",
				eTag: "etag-1",
				file: {
					mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					hashes: {
						sha256Hash: "sha256-abc",
						quickXorHash: "qxor-def",
					},
				},
			},
			bytes: new Uint8Array([1, 2, 3, 4]),
			mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});

		const adapter = getReadAdapter("onedrive");
		const result = await adapter!.fetch({
			connector: "onedrive",
			externalId: "od-item-1",
			url: null,
		});

		expect(downloadItemBytes).toHaveBeenCalledWith({ itemId: "od-item-1" });
		expect(result.buffer).toEqual(Buffer.from([1, 2, 3, 4]));
		expect(result.mimeType).toBe(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
		expect(result.extension).toBe("xlsx");
		expect(result.contentHash).toBe("sha256-abc");
		expect(result.sourceName).toBe("Budget_2026.xlsx");
		expect(result.text).toBeNull();
	});

	it("falls back through quickXorHash, eTag, and lastModifiedDateTime when sha256Hash is null", async () => {
		downloadItemBytes.mockResolvedValue({
			item: {
				id: "od-item-2",
				name: "Presentation.pptx",
				size: 2,
				lastModifiedDateTime: "2026-03-01T00:00:00Z",
				eTag: "etag-2",
				file: {
					mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
					hashes: {
						quickXorHash: "qxor-xyz",
					},
				},
			},
			bytes: new Uint8Array([9, 9]),
			mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		});

		const adapter = getReadAdapter("onedrive");
		const result = await adapter!.fetch({
			connector: "onedrive",
			externalId: "od-item-2",
			url: null,
		});

		expect(result.extension).toBe("pptx");
		expect(result.contentHash).toBe("qxor-xyz");
	});
});

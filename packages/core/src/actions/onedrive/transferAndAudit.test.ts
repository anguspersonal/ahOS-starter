import { describe, expect, it, vi } from "vitest";
import type { DriveFile, DrivePort } from "../../ports/drive.js";
import type { OneDriveItem, OneDrivePort } from "../../ports/onedrive.js";
import type { ActionContext } from "../types.js";
import { createOnedriveAuditVsGdriveAction } from "./audit.js";
import {
	createGdriveCopyToOnedriveAction,
	createOnedriveCopyToGdriveAction,
} from "./transfer.js";

const mockContext: ActionContext = {
	caller: "mcp",
	requestId: "test-req-1",
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

function makeOneDriveItem(overrides: Partial<OneDriveItem> = {}): OneDriveItem {
	return {
		id: "od-1",
		name: "report.pdf",
		size: 11,
		webUrl: "https://onedrive.live.com/od-1",
		createdDateTime: "2026-04-01T00:00:00Z",
		lastModifiedDateTime: "2026-04-02T00:00:00Z",
		parentReference: { id: "od-folder-1", path: "/drive/root:/Docs" },
		file: {
			mimeType: "application/pdf",
			hashes: {
				sha256Hash:
					"B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9",
			},
		},
		...overrides,
	};
}

function makeDriveFile(overrides: Partial<DriveFile> = {}): DriveFile {
	return {
		id: "gd-1",
		name: "report.pdf",
		mimeType: "application/pdf",
		size: "11",
		sha256Checksum:
			"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
		webViewLink: "https://drive.google.com/file/d/gd-1/view",
		parents: ["gd-folder-1"],
		...overrides,
	};
}

function makeMockPorts(
	onedriveOverrides: Partial<OneDrivePort> = {},
	driveOverrides: Partial<DrivePort> = {},
): { onedrive: OneDrivePort; drive: DrivePort } {
	const onedrive: OneDrivePort = {
		getQuota: vi.fn(),
		listChildren: vi.fn().mockResolvedValue({ items: [] }),
		searchItems: vi.fn().mockResolvedValue({ items: [] }),
		getItemMetadata: vi.fn(),
		downloadItemBytes: vi.fn(),
		createFolder: vi.fn(),
		uploadFile: vi.fn(),
		updateItem: vi.fn(),
		deleteItems: vi
			.fn()
			.mockImplementation(({ itemIds }: { itemIds: string[] }) =>
				Promise.resolve({ deletedItemIds: itemIds, failed: [] }),
			),
		...onedriveOverrides,
	};

	const drive: DrivePort = {
		getFile: vi.fn(),
		listFiles: vi.fn().mockResolvedValue({ files: [] }),
		listPermissions: vi.fn().mockResolvedValue([]),
		uploadFile: vi.fn(),
		downloadFile: vi.fn(),
		exportFile: vi.fn(),
		trashFile: vi.fn().mockResolvedValue({ id: "trashed", trashed: true }),
		...driveOverrides,
	};

	return { onedrive, drive };
}

describe("OneDrive <-> Google Drive transfer and backup audit actions", () => {
	describe("onedrive_copy_to_gdrive", () => {
		it("transfers a batch of OneDrive files to Google Drive and verifies SHA-256 and size", async () => {
			const payload1 = new TextEncoder().encode("hello world");
			const hash1 = await sha256Hex(payload1);
			const payload2 = new TextEncoder().encode("second file");
			const hash2 = await sha256Hex(payload2);

			const item1 = makeOneDriveItem({
				id: "od-1",
				name: "alpha.txt",
				size: payload1.byteLength,
				file: {
					mimeType: "text/plain",
					hashes: { sha256Hash: hash1.toUpperCase() },
				},
			});
			const item2 = makeOneDriveItem({
				id: "od-2",
				name: "beta.txt",
				size: payload2.byteLength,
				file: {
					mimeType: "text/plain",
					hashes: { sha256Hash: hash2.toUpperCase() },
				},
			});

			const { onedrive, drive } = makeMockPorts(
				{
					getItemMetadata: vi
						.fn()
						.mockResolvedValueOnce(item1)
						.mockResolvedValueOnce(item2),
					downloadItemBytes: vi
						.fn()
						.mockResolvedValueOnce({
							bytes: payload1,
							mimeType: "text/plain",
							item: item1,
						})
						.mockResolvedValueOnce({
							bytes: payload2,
							mimeType: "text/plain",
							item: item2,
						}),
				},
				{
					listFiles: vi.fn().mockResolvedValue({ files: [] }),
					uploadFile: vi
						.fn()
						.mockResolvedValueOnce(
							makeDriveFile({
								id: "gd-alpha",
								name: "alpha.txt",
								mimeType: "text/plain",
								size: String(payload1.byteLength),
								sha256Checksum: hash1,
							}),
						)
						.mockResolvedValueOnce(
							makeDriveFile({
								id: "gd-beta",
								name: "beta.txt",
								mimeType: "text/plain",
								size: String(payload2.byteLength),
								sha256Checksum: hash2,
							}),
						),
				},
			);

			const action = createOnedriveCopyToGdriveAction({ onedrive, drive });
			const result = await action.run(
				{
					item_ids: ["od-1", "od-2"],
					domain: "angus",
					gdrive_folder_id: "gd-folder-1",
					if_exists: "skip_if_identical",
				},
				mockContext,
			);

			expect(result.copied_count).toBe(2);
			expect(result.skipped_count).toBe(0);
			expect(result.failed_count).toBe(0);
			expect(result.results).toEqual([
				{
					source_id: "od-1",
					destination_id: "gd-alpha",
					name: "alpha.txt",
					status: "copied",
					size: payload1.byteLength,
					sha256: hash1,
				},
				{
					source_id: "od-2",
					destination_id: "gd-beta",
					name: "beta.txt",
					status: "copied",
					size: payload2.byteLength,
					sha256: hash2,
				},
			]);
		});

		it("skips upload when if_exists is skip_if_identical and destination file matches size and SHA-256", async () => {
			const payload = new TextEncoder().encode("hello world");
			const hash = await sha256Hex(payload);

			const { onedrive, drive } = makeMockPorts(
				{
					getItemMetadata: vi.fn().mockResolvedValue(
						makeOneDriveItem({
							id: "od-1",
							name: "report.pdf",
							size: payload.byteLength,
							file: {
								mimeType: "application/pdf",
								hashes: { sha256Hash: hash.toUpperCase() },
							},
						}),
					),
				},
				{
					listFiles: vi.fn().mockResolvedValue({
						files: [
							makeDriveFile({
								id: "gd-existing",
								name: "report.pdf",
								size: String(payload.byteLength),
								sha256Checksum: hash,
							}),
						],
					}),
				},
			);

			const action = createOnedriveCopyToGdriveAction({ onedrive, drive });
			const result = await action.run(
				{
					item_ids: ["od-1"],
					domain: "angus",
					gdrive_folder_id: "gd-folder-1",
					if_exists: "skip_if_identical",
				},
				mockContext,
			);

			expect(result.skipped_count).toBe(1);
			expect(result.copied_count).toBe(0);
			expect(onedrive.downloadItemBytes).not.toHaveBeenCalled();
			expect(drive.uploadFile).not.toHaveBeenCalled();
			expect(result.results[0]).toEqual({
				source_id: "od-1",
				destination_id: "gd-existing",
				name: "report.pdf",
				status: "skipped_identical",
				size: payload.byteLength,
				sha256: hash,
			});
		});

		it("trashes destination file and marks cleaned_up: true when Google Drive SHA-256 mismatches", async () => {
			const payload = new TextEncoder().encode("hello world");
			const hash = await sha256Hex(payload);
			const item = makeOneDriveItem({
				id: "od-1",
				name: "report.pdf",
				size: payload.byteLength,
				file: {
					mimeType: "application/pdf",
					hashes: { sha256Hash: hash.toUpperCase() },
				},
			});

			const { onedrive, drive } = makeMockPorts(
				{
					getItemMetadata: vi.fn().mockResolvedValue(item),
					downloadItemBytes: vi.fn().mockResolvedValue({
						bytes: payload,
						mimeType: "application/pdf",
						item,
					}),
				},
				{
					listFiles: vi.fn().mockResolvedValue({ files: [] }),
					uploadFile: vi.fn().mockResolvedValue(
						makeDriveFile({
							id: "gd-corrupt",
							name: "report.pdf",
							size: String(payload.byteLength),
							sha256Checksum:
								"0000000000000000000000000000000000000000000000000000000000000000",
						}),
					),
				},
			);

			const action = createOnedriveCopyToGdriveAction({ onedrive, drive });
			const result = await action.run(
				{
					item_ids: ["od-1"],
					domain: "angus",
					gdrive_folder_id: "gd-folder-1",
					if_exists: "skip_if_identical",
				},
				mockContext,
			);

			expect(result.failed_count).toBe(1);
			expect(result.copied_count).toBe(0);
			expect(drive.trashFile).toHaveBeenCalledWith({
				domain: "angus",
				fileId: "gd-corrupt",
			});
			expect(result.results[0]).toMatchObject({
				source_id: "od-1",
				destination_id: null,
				status: "failed",
				cleaned_up: true,
				error: expect.stringMatching(/Destination parity verification failed/i),
			});
		});

		it("marks cleaned_up: false and preserves parity failure error when drive.trashFile throws during cleanup", async () => {
			const payload = new TextEncoder().encode("hello world");
			const hash = await sha256Hex(payload);
			const item = makeOneDriveItem({
				id: "od-1",
				name: "report.pdf",
				size: payload.byteLength,
				file: {
					mimeType: "application/pdf",
					hashes: { sha256Hash: hash.toUpperCase() },
				},
			});

			const { onedrive, drive } = makeMockPorts(
				{
					getItemMetadata: vi.fn().mockResolvedValue(item),
					downloadItemBytes: vi.fn().mockResolvedValue({
						bytes: payload,
						mimeType: "application/pdf",
						item,
					}),
				},
				{
					listFiles: vi.fn().mockResolvedValue({ files: [] }),
					uploadFile: vi.fn().mockResolvedValue(
						makeDriveFile({
							id: "gd-corrupt",
							name: "report.pdf",
							size: String(payload.byteLength),
							sha256Checksum:
								"0000000000000000000000000000000000000000000000000000000000000000",
						}),
					),
					trashFile: vi
						.fn()
						.mockRejectedValue(new Error("Drive API 503 during trash")),
				},
			);

			const action = createOnedriveCopyToGdriveAction({ onedrive, drive });
			const result = await action.run(
				{
					item_ids: ["od-1"],
					domain: "angus",
					gdrive_folder_id: "gd-folder-1",
					if_exists: "skip_if_identical",
				},
				mockContext,
			);

			expect(result.failed_count).toBe(1);
			expect(result.results[0]).toMatchObject({
				source_id: "od-1",
				destination_id: null,
				name: "report.pdf",
				status: "failed",
				cleaned_up: false,
				error: expect.stringMatching(
					/Destination parity verification failed.*cleanup failed: Drive API 503 during trash/i,
				),
			});
		});

		it("fails gracefully for folders and files exceeding 100 MiB without aborting the batch", async () => {
			const { onedrive, drive } = makeMockPorts({
				getItemMetadata: vi
					.fn()
					.mockResolvedValueOnce(
						makeOneDriveItem({
							id: "od-folder",
							name: "Archive",
							file: undefined,
							folder: { childCount: 4 },
						}),
					)
					.mockResolvedValueOnce(
						makeOneDriveItem({
							id: "od-huge",
							name: "video.mp4",
							size: 105 * 1024 * 1024,
						}),
					),
			});

			const action = createOnedriveCopyToGdriveAction({ onedrive, drive });
			const result = await action.run(
				{
					item_ids: ["od-folder", "od-huge"],
					domain: "angus",
					gdrive_folder_id: "gd-folder-1",
					if_exists: "skip_if_identical",
				},
				mockContext,
			);

			expect(result.failed_count).toBe(2);
			expect(result.results[0].error).toMatch(/folder/i);
			expect(result.results[1].error).toMatch(/104857600-byte per-file transfer limit/i);
		});
	});

	describe("gdrive_copy_to_onedrive", () => {
		it("exports Google Docs/Sheets/Slides to Office formats (.docx/.xlsx/.pptx) and verifies upload", async () => {
			const docxBytes = new TextEncoder().encode("exported docx payload");
			const docxHash = await sha256Hex(docxBytes);

			const { onedrive, drive } = makeMockPorts(
				{
					listChildren: vi.fn().mockResolvedValue({ items: [] }),
					uploadFile: vi.fn().mockResolvedValue(
						makeOneDriveItem({
							id: "od-doc-1",
							name: "Strategy Memo.docx",
							size: docxBytes.byteLength,
							file: {
								mimeType:
									"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
								hashes: { sha256Hash: docxHash.toUpperCase() },
							},
						}),
					),
				},
				{
					getFile: vi.fn().mockResolvedValue(
						makeDriveFile({
							id: "gd-doc-1",
							name: "Strategy Memo",
							mimeType: "application/vnd.google-apps.document",
							size: undefined,
							sha256Checksum: undefined,
						}),
					),
					exportFile: vi.fn().mockResolvedValue(docxBytes),
				},
			);

			const action = createGdriveCopyToOnedriveAction({ onedrive, drive });
			const result = await action.run(
				{
					domain: "angus",
					file_ids: ["gd-doc-1"],
					onedrive_parent_id: "od-folder-1",
					if_exists: "skip_if_identical",
				},
				mockContext,
			);

			expect(drive.exportFile).toHaveBeenCalledWith({
				domain: "angus",
				fileId: "gd-doc-1",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				maxBytes: 100 * 1024 * 1024,
			});
			expect(onedrive.uploadFile).toHaveBeenCalledWith({
				parentId: "od-folder-1",
				name: "Strategy Memo.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				data: docxBytes,
				conflictBehavior: "fail",
			});
			expect(result.copied_count).toBe(1);
			expect(result.results[0]).toEqual({
				source_id: "gd-doc-1",
				destination_id: "od-doc-1",
				name: "Strategy Memo.docx",
				status: "copied",
				size: docxBytes.byteLength,
				sha256: docxHash,
				exported: true,
				exported_mime_type:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			});
		});

		it("deletes corrupted OneDrive upload and marks cleaned_up: true when OneDrive SHA-256 mismatches", async () => {
			const payload = new TextEncoder().encode("binary content");
			const hash = await sha256Hex(payload);

			const { onedrive, drive } = makeMockPorts(
				{
					listChildren: vi.fn().mockResolvedValue({ items: [] }),
					uploadFile: vi.fn().mockResolvedValue(
						makeOneDriveItem({
							id: "od-corrupt",
							name: "archive.zip",
							size: payload.byteLength,
							file: {
								mimeType: "application/zip",
								hashes: {
									sha256Hash:
										"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
								},
							},
						}),
					),
				},
				{
					getFile: vi.fn().mockResolvedValue(
						makeDriveFile({
							id: "gd-zip",
							name: "archive.zip",
							mimeType: "application/zip",
							size: String(payload.byteLength),
							sha256Checksum: hash,
						}),
					),
					downloadFile: vi.fn().mockResolvedValue(payload),
				},
			);

			const action = createGdriveCopyToOnedriveAction({ onedrive, drive });
			const result = await action.run(
				{
					domain: "angus",
					file_ids: ["gd-zip"],
					onedrive_parent_id: "od-folder-1",
					if_exists: "skip_if_identical",
				},
				mockContext,
			);

			expect(result.failed_count).toBe(1);
			expect(onedrive.deleteItems).toHaveBeenCalledWith({
				itemIds: ["od-corrupt"],
			});
			expect(result.results[0]).toMatchObject({
				source_id: "gd-zip",
				destination_id: null,
				status: "failed",
				cleaned_up: true,
				error: expect.stringMatching(/Destination parity verification failed/i),
			});
		});

		it("marks cleaned_up: false and preserves parity failure error when onedrive.deleteItems reports batch failure or throws", async () => {
			const payload = new TextEncoder().encode("binary content");
			const hash = await sha256Hex(payload);

			const { onedrive, drive } = makeMockPorts(
				{
					listChildren: vi.fn().mockResolvedValue({ items: [] }),
					uploadFile: vi
						.fn()
						.mockResolvedValueOnce(
							makeOneDriveItem({
								id: "od-corrupt-1",
								name: "archive1.zip",
								size: payload.byteLength,
								file: {
									mimeType: "application/zip",
									hashes: {
										sha256Hash:
											"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
									},
								},
							}),
						)
						.mockResolvedValueOnce(
							makeOneDriveItem({
								id: "od-corrupt-2",
								name: "archive2.zip",
								size: payload.byteLength,
								file: {
									mimeType: "application/zip",
									hashes: {
										sha256Hash:
											"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
									},
								},
							}),
						),
					deleteItems: vi
						.fn()
						.mockResolvedValueOnce({
							deletedItemIds: [],
							failed: [
								{
									itemId: "od-corrupt-1",
									status: 423,
									error: "Item is locked",
								},
							],
						})
						.mockRejectedValueOnce(new Error("Graph batch network error")),
				},
				{
					getFile: vi
						.fn()
						.mockResolvedValueOnce(
							makeDriveFile({
								id: "gd-zip-1",
								name: "archive1.zip",
								mimeType: "application/zip",
								size: String(payload.byteLength),
								sha256Checksum: hash,
							}),
						)
						.mockResolvedValueOnce(
							makeDriveFile({
								id: "gd-zip-2",
								name: "archive2.zip",
								mimeType: "application/zip",
								size: String(payload.byteLength),
								sha256Checksum: hash,
							}),
						),
					downloadFile: vi.fn().mockResolvedValue(payload),
				},
			);

			const action = createGdriveCopyToOnedriveAction({ onedrive, drive });
			const result = await action.run(
				{
					domain: "angus",
					file_ids: ["gd-zip-1", "gd-zip-2"],
					onedrive_parent_id: "od-folder-1",
					if_exists: "skip_if_identical",
				},
				mockContext,
			);

			expect(result.failed_count).toBe(2);
			expect(result.results[0]).toMatchObject({
				source_id: "gd-zip-1",
				destination_id: null,
				name: "archive1.zip",
				status: "failed",
				cleaned_up: false,
				error: expect.stringMatching(
					/Destination parity verification failed.*cleanup failed: Item is locked/i,
				),
			});
			expect(result.results[1]).toMatchObject({
				source_id: "gd-zip-2",
				destination_id: null,
				name: "archive2.zip",
				status: "failed",
				cleaned_up: false,
				error: expect.stringMatching(
					/Destination parity verification failed.*cleanup failed: Graph batch network error/i,
				),
			});
		});
	});

	describe("onedrive_audit_vs_gdrive", () => {
		it("classifies folder items into matched, only_in_onedrive, only_in_gdrive, size_or_hash_mismatch, and counter_copy_candidates", async () => {
			const sharedHash = "a".repeat(64);
			const differentHash = "b".repeat(64);

			const { onedrive, drive } = makeMockPorts(
				{
					listChildren: vi.fn().mockResolvedValue({
						items: [
							// 1. Exact match by name, size, and SHA-256
							makeOneDriveItem({
								id: "od-matched",
								name: "Photo.jpg",
								size: 5000,
								file: {
									mimeType: "image/jpeg",
									hashes: { sha256Hash: sharedHash.toUpperCase() },
								},
							}),
							// 2. Counter-copy duplicate ("Photo 1.jpg") whose canonical "Photo.jpg" has identical size and SHA-256
							makeOneDriveItem({
								id: "od-counter-1",
								name: "Photo 1.jpg",
								size: 5000,
								file: {
									mimeType: "image/jpeg",
									hashes: { sha256Hash: sharedHash.toUpperCase() },
								},
							}),
							// 3. Google Doc exported as .docx in OneDrive ("Notes.docx" <-> "Notes" Google Doc)
							makeOneDriveItem({
								id: "od-notes-docx",
								name: "Notes.docx",
								size: 12000,
								file: {
									mimeType:
										"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
								},
							}),
							// 4. Size/hash mismatch ("Budget.xlsx")
							makeOneDriveItem({
								id: "od-mismatch",
								name: "Budget.xlsx",
								size: 8000,
								file: {
									mimeType:
										"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
									hashes: { sha256Hash: sharedHash.toUpperCase() },
								},
							}),
							// 5. Only in OneDrive ("UnbackedUp.pdf")
							makeOneDriveItem({
								id: "od-only",
								name: "UnbackedUp.pdf",
								size: 3200,
								file: {
									mimeType: "application/pdf",
									hashes: { sha256Hash: sharedHash.toUpperCase() },
								},
							}),
						],
					}),
				},
				{
					listFiles: vi.fn().mockResolvedValue({
						files: [
							makeDriveFile({
								id: "gd-matched",
								name: "Photo.jpg",
								mimeType: "image/jpeg",
								size: "5000",
								sha256Checksum: sharedHash,
							}),
							makeDriveFile({
								id: "gd-notes-doc",
								name: "Notes",
								mimeType: "application/vnd.google-apps.document",
								size: undefined,
								sha256Checksum: undefined,
							}),
							makeDriveFile({
								id: "gd-mismatch",
								name: "Budget.xlsx",
								mimeType:
									"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
								size: "8000",
								sha256Checksum: differentHash,
							}),
							makeDriveFile({
								id: "gd-only",
								name: "CloudOnly.png",
								mimeType: "image/png",
								size: "9000",
								sha256Checksum: sharedHash,
							}),
						],
					}),
				},
			);

			const action = createOnedriveAuditVsGdriveAction({ onedrive, drive });
			const report = await action.run(
				{
					onedrive_folder_id: "od-folder-1",
					domain: "angus",
					gdrive_folder_id: "gd-folder-1",
					recursive: false,
					max_items: 500,
				},
				mockContext,
			);

			expect(report.summary).toEqual({
				matched_count: 2,
				only_in_onedrive_count: 1,
				only_in_gdrive_count: 1,
				size_or_hash_mismatch_count: 1,
				counter_copy_candidates_count: 1,
				counter_copy_reclaimable_bytes: 5000,
			});

			expect(report.matched.map((m) => m.onedrive_item_id)).toEqual([
				"od-matched",
				"od-notes-docx",
			]);
			expect(report.only_in_onedrive.map((i) => i.item_id)).toEqual(["od-only"]);
			expect(report.only_in_gdrive.map((i) => i.file_id)).toEqual(["gd-only"]);
			expect(report.size_or_hash_mismatch).toEqual([
				{
					relative_path: "Budget.xlsx",
					onedrive_item_id: "od-mismatch",
					gdrive_file_id: "gd-mismatch",
					onedrive_size: 8000,
					gdrive_size: 8000,
					onedrive_sha256: sharedHash,
					gdrive_sha256: differentHash,
				},
			]);
			expect(report.counter_copy_candidates).toEqual([
				{
					item_id: "od-counter-1",
					name: "Photo 1.jpg",
					relative_path: "Photo 1.jpg",
					canonical_item_id: "od-matched",
					canonical_name: "Photo.jpg",
					canonical_relative_path: "Photo.jpg",
					counter: 1,
					size: 5000,
					sha256Hash: sharedHash,
				},
			]);
			expect(report.counter_copy_item_ids).toEqual(["od-counter-1"]);
		});
	});
});

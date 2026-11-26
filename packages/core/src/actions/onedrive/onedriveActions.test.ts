import { describe, expect, it, vi } from "vitest";
import { OFFICE_OPEN_XML_MIMES } from "../../domain/extract/office.js";
import type { OneDriveItem, OneDrivePort } from "../../ports/onedrive.js";
import { createActionContext } from "../defineAction.js";
import {
	createOnedriveCreateFolderAction,
	createOnedriveDeleteAction,
	createOnedriveGetMetadataAction,
	createOnedriveGetQuotaAction,
	createOnedriveListAction,
	createOnedriveMoveAction,
	createOnedriveReadFileAction,
	createOnedriveRenameAction,
	createOnedriveSearchAction,
	createOnedriveUploadFileAction,
	PROTECTED_ONEDRIVE_TOP_LEVEL_FOLDERS,
} from "./index.js";

function buildStoredZip(entries: { name: string; content: string }[]): Uint8Array {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const dataBytes = encoder.encode(entry.content);
		const record = new Uint8Array(30 + nameBytes.byteLength + dataBytes.byteLength);
		const view = new DataView(record.buffer);
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, 20, true);
		view.setUint16(8, 0, true);
		view.setUint32(18, dataBytes.byteLength, true);
		view.setUint32(22, dataBytes.byteLength, true);
		view.setUint16(26, nameBytes.byteLength, true);
		record.set(nameBytes, 30);
		record.set(dataBytes, 30 + nameBytes.byteLength);
		chunks.push(record);
	}
	const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function createMockOneDrivePort(
	overrides: Partial<OneDrivePort> = {},
): OneDrivePort {
	return {
		getQuota: vi.fn(async () => ({
			id: "drive-1",
			driveType: "personal",
			total: 1099511627776,
			used: 5368709120,
			remaining: 1094142918656,
			deleted: 1048576,
			state: "normal",
		})),
		listChildren: vi.fn(async () => ({ items: [] })),
		searchItems: vi.fn(async () => ({ items: [] })),
		getItemMetadata: vi.fn(async ({ itemId, path }) => ({
			id: itemId ?? "item-path",
			name: path ? path.split("/").pop() || "item" : "file.txt",
			size: 12,
			parentReference: {
				id: "folder-1",
				path: "/drive/root:/1.Projects",
			},
			file: {
				mimeType: "text/plain",
				hashes: {
					sha256Hash: "abc123",
				},
			},
		})),
		downloadItemBytes: vi.fn(async ({ itemId }) => ({
			item: {
				id: itemId,
				name: "notes.md",
				size: 11,
				file: { mimeType: "text/markdown" },
			},
			bytes: new TextEncoder().encode("Hello world"),
			mimeType: "text/markdown",
		})),
		createFolder: vi.fn(async ({ name, parentId }) => ({
			id: "folder-new",
			name,
			parentReference: { id: parentId ?? "root", path: "/drive/root:" },
			folder: { childCount: 0 },
		})),
		uploadFile: vi.fn(async ({ name, data, mimeType }) => ({
			id: "file-uploaded",
			name,
			size: data.byteLength,
			file: { mimeType: mimeType ?? "application/octet-stream" },
		})),
		readLocalFile: vi.fn(async (localPath: string) => ({
			bytes: new TextEncoder().encode(`from:${localPath}`),
			fileName: localPath.split("/").pop() || "local.bin",
		})),
		updateItem: vi.fn(async ({ itemId, name, newParentId }) => ({
			id: itemId,
			name: name ?? "existing.txt",
			parentReference: { id: newParentId ?? "folder-1", path: "/drive/root:/1.Projects" },
		})),
		deleteItems: vi.fn(async ({ itemIds }) => ({
			deletedItemIds: itemIds,
			failed: [],
		})),
		...overrides,
	};
}

describe("personal OneDrive core actions (#2044)", () => {
	const ctx = createActionContext();

	it("omits domain and account from all 10 personal OneDrive action schemas", () => {
		const port = createMockOneDrivePort();
		const actions = [
			createOnedriveGetQuotaAction(port),
			createOnedriveListAction(port),
			createOnedriveSearchAction(port),
			createOnedriveGetMetadataAction(port),
			createOnedriveReadFileAction(port),
			createOnedriveCreateFolderAction(port),
			createOnedriveUploadFileAction(port),
			createOnedriveMoveAction(port),
			createOnedriveRenameAction(port),
			createOnedriveDeleteAction(port),
		];

		for (const action of actions) {
			const shape = (action.schema as any).shape ?? {};
			expect(shape, `${action.id} must not declare domain`).not.toHaveProperty("domain");
			expect(shape, `${action.id} must not declare account`).not.toHaveProperty("account");
		}
	});

	it("onedrive_get_quota returns personal OneDrive quota", async () => {
		const port = createMockOneDrivePort();
		const action = createOnedriveGetQuotaAction(port);

		const res = await action.run({}, ctx);
		expect(res.state).toBe("normal");
		expect(res.total).toBe(1099511627776);
		expect(port.getQuota).toHaveBeenCalledTimes(1);
	});

	it("onedrive_list defaults folder_id to root and forwards path and pagination options", async () => {
		const port = createMockOneDrivePort();
		const action = createOnedriveListAction(port);

		await action.run({}, ctx);
		expect(port.listChildren).toHaveBeenLastCalledWith({
			folderId: "root",
			path: undefined,
			pageSize: 50,
			cursor: undefined,
			orderBy: undefined,
		});

		await action.run(
			{
				path: "/1.Projects",
				page_size: 25,
				cursor: "https://graph.microsoft.com/next",
				order_by: "name asc",
			},
			ctx,
		);
		expect(port.listChildren).toHaveBeenLastCalledWith({
			folderId: undefined,
			path: "/1.Projects",
			pageSize: 25,
			cursor: "https://graph.microsoft.com/next",
			orderBy: "name asc",
		});
	});

	it("onedrive_search trims query and forwards folder_id and pagination", async () => {
		const port = createMockOneDrivePort();
		const action = createOnedriveSearchAction(port);

		await action.run({ query: "  invoice 2026  ", folder_id: "folder-1", page_size: 10 }, ctx);
		expect(port.searchItems).toHaveBeenCalledWith({
			query: "invoice 2026",
			folderId: "folder-1",
			pageSize: 10,
			cursor: undefined,
		});
	});

	it("onedrive_get_metadata requires item_id or path and forwards lookup", async () => {
		const port = createMockOneDrivePort();
		const action = createOnedriveGetMetadataAction(port);

		await expect(action.run({}, ctx)).rejects.toThrow(/requires either item_id or path/);

		const item = await action.run({ path: "/1.Projects/readme.md" }, ctx);
		expect(item.name).toBe("readme.md");
		expect(port.getItemMetadata).toHaveBeenCalledWith({
			itemId: undefined,
			path: "/1.Projects/readme.md",
		});
	});

	it("onedrive_read_file reads UTF-8 text, truncates at max_chars, and refuses folders and binary files", async () => {
		const longText = "a".repeat(250);
		const port = createMockOneDrivePort({
			getItemMetadata: vi.fn(async ({ itemId }) => {
				if (itemId === "folder-id") {
					return {
						id: "folder-id",
						name: "1.Projects",
						folder: { childCount: 3 },
					};
				}
				if (itemId === "binary-id") {
					return {
						id: "binary-id",
						name: "archive.zip",
						file: { mimeType: "application/zip" },
					};
				}
				return {
					id: itemId ?? "text-id",
					name: "notes.md",
					file: { mimeType: "text/markdown" },
				};
			}),
			downloadItemBytes: vi.fn(async ({ itemId }) => ({
				item: {
					id: itemId,
					name: "notes.md",
					file: { mimeType: "text/markdown" },
				},
				bytes: new TextEncoder().encode(longText),
				mimeType: "text/markdown",
			})),
		});

		const action = createOnedriveReadFileAction(port);

		await expect(action.run({ item_id: "folder-id" }, ctx)).rejects.toThrow(
			/cannot read folder/,
		);
		await expect(action.run({ item_id: "binary-id" }, ctx)).rejects.toThrow(
			/refused binary file/,
		);

		const res = await action.run({ item_id: "text-id", max_chars: 100 }, ctx);
		expect(res.truncated).toBe(true);
		expect(res.content.length).toBe(100);
		expect(res.total_chars).toBe(250);
		expect(port.downloadItemBytes).toHaveBeenCalledWith({
			itemId: "text-id",
			maxBytes: 10_485_760,
		});
	});

	it("onedrive_read_file rejects files larger than 10 MiB (10_485_760 bytes) before calling downloadItemBytes", async () => {
		const port = createMockOneDrivePort({
			getItemMetadata: vi.fn(async ({ itemId }) => ({
				id: itemId ?? "oversized-id",
				name: "huge-log.txt",
				size: 10_485_761,
				file: { mimeType: "text/plain" },
			})),
		});
		const action = createOnedriveReadFileAction(port);

		await expect(
			action.run({ item_id: "oversized-id" }, ctx),
		).rejects.toThrow(
			/onedrive_read_file refuses files larger than 10485760 bytes \(got 10485761 bytes for "huge-log\.txt"\)\./,
		);
		expect(port.downloadItemBytes).not.toHaveBeenCalled();
	});

	it("onedrive_read_file extracts Markdown text from .docx, .xlsx, and .pptx files (#2084)", async () => {
		const docxBytes = buildStoredZip([
			{
				name: "word/document.xml",
				content: `<w:document><w:body><w:p><w:r><w:t>${"Word content ".repeat(15)}</w:t></w:r></w:p></w:body></w:document>`,
			},
		]);
		const xlsxBytes = buildStoredZip([
			{
				name: "xl/workbook.xml",
				content: `<workbook><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			},
			{
				name: "xl/worksheets/sheet1.xml",
				content: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ARR</t></is></c><c r="B1"><v>250000</v></c></row></sheetData></worksheet>`,
			},
		]);
		const pptxBytes = buildStoredZip([
			{
				name: "ppt/slides/slide1.xml",
				content: `<p:sld><p:cSld><p:spTree><a:p><a:r><a:t>Board Deck Title</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
			},
		]);

		const port = createMockOneDrivePort({
			getItemMetadata: vi.fn(async ({ itemId }) => {
				if (itemId === "docx-id") {
					return {
						id: "docx-id",
						name: "proposal.docx",
						file: { mimeType: OFFICE_OPEN_XML_MIMES.docx },
					};
				}
				if (itemId === "xlsx-id") {
					return {
						id: "xlsx-id",
						name: "budget.xlsx",
						file: { mimeType: OFFICE_OPEN_XML_MIMES.xlsx },
					};
				}
				return {
					id: "pptx-id",
					name: "pitch.pptx",
					file: { mimeType: "application/octet-stream" },
				};
			}),
			downloadItemBytes: vi.fn(async ({ itemId }) => {
				if (itemId === "docx-id") {
					return {
						item: {
							id: "docx-id",
							name: "proposal.docx",
							file: { mimeType: OFFICE_OPEN_XML_MIMES.docx },
						},
						bytes: docxBytes,
						mimeType: OFFICE_OPEN_XML_MIMES.docx,
					};
				}
				if (itemId === "xlsx-id") {
					return {
						item: {
							id: "xlsx-id",
							name: "budget.xlsx",
							file: { mimeType: OFFICE_OPEN_XML_MIMES.xlsx },
						},
						bytes: xlsxBytes,
						mimeType: OFFICE_OPEN_XML_MIMES.xlsx,
					};
				}
				return {
					item: {
						id: "pptx-id",
						name: "pitch.pptx",
						file: { mimeType: "application/octet-stream" },
					},
					bytes: pptxBytes,
					mimeType: "application/octet-stream",
				};
			}),
		});

		const action = createOnedriveReadFileAction(port);

		const docxRes = await action.run({ item_id: "docx-id", max_chars: 100 }, ctx);
		expect(docxRes.truncated).toBe(true);
		expect(docxRes.content.length).toBe(100);
		expect(docxRes.content).toContain("Word content");

		const xlsxRes = await action.run({ item_id: "xlsx-id" }, ctx);
		expect(xlsxRes.truncated).toBe(false);
		expect(xlsxRes.content).toContain("## Revenue");
		expect(xlsxRes.content).toContain("| ARR | 250000 |");

		const pptxRes = await action.run({ item_id: "pptx-id" }, ctx);
		expect(pptxRes.truncated).toBe(false);
		expect(pptxRes.content).toContain("## Slide 1");
		expect(pptxRes.content).toContain("Board Deck Title");
	});

	it("onedrive_create_folder and onedrive_upload_file create folders and upload inline or local_path files", async () => {
		const port = createMockOneDrivePort();
		const createFolder = createOnedriveCreateFolderAction(port);
		const uploadFile = createOnedriveUploadFileAction(port);

		const folder = await createFolder.run({ name: "Subfolder" }, ctx);
		expect(folder.name).toBe("Subfolder");
		expect(port.createFolder).toHaveBeenCalledWith({
			name: "Subfolder",
			parentId: "root",
			conflictBehavior: "fail",
		});

		const uploadedInline = await uploadFile.run(
			{
				name: "hello.txt",
				content: "Hello OneDrive",
			},
			ctx,
		);
		expect(uploadedInline.name).toBe("hello.txt");
		expect(uploadedInline.size).toBe(14);

		const uploadedLocal = await uploadFile.run(
			{
				local_path: "/tmp/report.pdf",
				parent_id: "folder-1",
				conflict_behavior: "replace",
			},
			ctx,
		);
		expect(uploadedLocal.name).toBe("report.pdf");
		expect(port.readLocalFile).toHaveBeenCalledWith("/tmp/report.pdf");

		await expect(
			uploadFile.run({ name: "both.txt", content: "x", local_path: "/tmp/x" }, ctx),
		).rejects.toThrow(/exactly one of content or local_path/);
	});

	it("onedrive_move and onedrive_rename delegate to updateItem", async () => {
		const port = createMockOneDrivePort();
		const moveAction = createOnedriveMoveAction(port);
		const renameAction = createOnedriveRenameAction(port);

		await moveAction.run(
			{
				item_id: "item-1",
				new_parent_id: "folder-2",
				new_name: "moved.txt",
				conflict_behavior: "rename",
			},
			ctx,
		);
		expect(port.updateItem).toHaveBeenLastCalledWith({
			itemId: "item-1",
			newParentId: "folder-2",
			name: "moved.txt",
			conflictBehavior: "rename",
		});

		await renameAction.run(
			{
				item_id: "item-1",
				name: "renamed.txt",
			},
			ctx,
		);
		expect(port.updateItem).toHaveBeenLastCalledWith({
			itemId: "item-1",
			name: "renamed.txt",
			conflictBehavior: "fail",
		});
	});

	describe("onedrive_delete safety rails", () => {
		it("hard-blocks deleting the OneDrive root folder and protected top-level folders", async () => {
			const itemsById: Record<string, OneDriveItem> = {
				"root-item-id": {
					id: "root-item-id",
					name: "root",
					folder: { childCount: 6 },
				},
			};
			for (const folderName of PROTECTED_ONEDRIVE_TOP_LEVEL_FOLDERS) {
				itemsById[`id-${folderName}`] = {
					id: `id-${folderName}`,
					name: folderName,
					parentReference: { id: "root", path: "/drive/root:" },
					folder: { childCount: 0 },
				};
			}

			const port = createMockOneDrivePort({
				getItemMetadata: vi.fn(async ({ itemId }) => itemsById[itemId!]),
			});
			const deleteAction = createOnedriveDeleteAction(port);

			await expect(
				deleteAction.run({ item_ids: ["root"] }, ctx),
			).rejects.toThrow(/refuses to delete the OneDrive root folder/);

			await expect(
				deleteAction.run({ item_ids: ["root-item-id"] }, ctx),
			).rejects.toThrow(/refuses to delete the OneDrive root folder/);

			for (const folderName of PROTECTED_ONEDRIVE_TOP_LEVEL_FOLDERS) {
				await expect(
					deleteAction.run({ item_ids: [`id-${folderName}`] }, ctx),
				).rejects.toThrow(/refuses to delete protected top-level folder/);
			}

			expect(port.deleteItems).not.toHaveBeenCalled();
		});

		it("blocks non-empty folders unless allow_non_empty_folder is true", async () => {
			const port = createMockOneDrivePort({
				getItemMetadata: vi.fn(async ({ itemId }) => ({
					id: itemId!,
					name: "Old Subfolder",
					parentReference: { id: "folder-1", path: "/drive/root:/4.Archive" },
					folder: { childCount: 4 },
				})),
			});
			const deleteAction = createOnedriveDeleteAction(port);

			await expect(
				deleteAction.run({ item_ids: ["subfolder-1"] }, ctx),
			).rejects.toThrow(/allow_non_empty_folder: true/);
			expect(port.deleteItems).not.toHaveBeenCalled();

			const res = await deleteAction.run(
				{ item_ids: ["subfolder-1"], allow_non_empty_folder: true },
				ctx,
			);
			expect(res.deleted_item_ids).toEqual(["subfolder-1"]);
			expect(port.deleteItems).toHaveBeenCalledWith({ itemIds: ["subfolder-1"] });
		});

		it("supports dry_run preview without calling deleteItems and executes batch delete when dry_run is false", async () => {
			const port = createMockOneDrivePort({
				getItemMetadata: vi.fn(async ({ itemId }) => ({
					id: itemId!,
					name: `${itemId}.txt`,
					parentReference: { id: "folder-1", path: "/drive/root:/8.To Sort" },
					file: { mimeType: "text/plain" },
				})),
			});
			const deleteAction = createOnedriveDeleteAction(port);

			const preview = await deleteAction.run(
				{ item_ids: ["item-1", "item-2"], dry_run: true },
				ctx,
			);
			expect(preview.dry_run).toBe(true);
			expect(preview.items.map((i) => i.id)).toEqual(["item-1", "item-2"]);
			expect(preview.deleted_item_ids).toEqual([]);
			expect(port.deleteItems).not.toHaveBeenCalled();

			const live = await deleteAction.run(
				{ item_ids: ["item-1", "item-2"] },
				ctx,
			);
			expect(live.dry_run).toBe(false);
			expect(live.deleted_item_ids).toEqual(["item-1", "item-2"]);
			expect(port.deleteItems).toHaveBeenCalledWith({
				itemIds: ["item-1", "item-2"],
			});
		});
	});
});

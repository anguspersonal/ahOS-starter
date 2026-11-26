import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import { DriveApiError, FOLDER_MIME_TYPE, type DrivePort } from "../../ports/drive.js";
import type { ArtifactInsertRow, ArtifactRepository } from "../../ports/artifacts.js";
import type { StoragePort } from "../../ports/storage.js";
import { executeAction } from "../adapters/direct.js";
import { isPendingApproval, setActionApprovalStore } from "../gate.js";
import {
	createDriveImportFileAction,
	FOLDER_PATH_FIELDS,
	formatDriveImportFileMcp,
	IMPORT_FILE_FIELDS,
	type DriveImportFilePorts,
} from "./importFile.js";

const FIXED_UUID = "11111111-2222-4333-8444-555555555555";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";

function makeFixture(overrides?: {
	fileMeta?: Record<string, unknown>;
	folderMeta?: Record<string, Record<string, unknown>>;
	downloaded?: { bytes: Uint8Array; mimeType: string; extension: string | null };
	sortedExistingId?: string | null;
}) {
	const insertedRows: ArtifactInsertRow[] = [];
	const uploads: Array<{ bucket: string; path: string; body: string | Uint8Array; contentType: string }> = [];
	const removed: Array<{ bucket: string; paths: string[] }> = [];
	const embedded: Array<{ id: string; fields: Record<string, unknown> }> = [];

	const getFile = vi.fn(async ({ fileId }: { fileId: string; fields?: string }) => {
		if (overrides?.folderMeta && fileId in overrides.folderMeta) {
			return overrides.folderMeta[fileId] as any;
		}
		return {
			id: fileId,
			name: "Notes.txt",
			mimeType: "text/plain",
			webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
			parents: ["folder-1"],
			createdTime: "2026-03-10T09:00:00.000Z",
			modifiedTime: "2026-03-11T10:00:00.000Z",
			...overrides?.fileMeta,
		} as any;
	});

	const downloadFile = vi.fn(
		async () =>
			overrides?.downloaded ?? {
				bytes: new TextEncoder().encode("hello world"),
				mimeType: "text/plain",
				extension: null,
			},
	);
	const listFiles = vi.fn(async () => ({
		files: overrides?.sortedExistingId ? [{ id: overrides.sortedExistingId }] : [],
	}));
	const createFile = vi.fn(async () => ({ id: "sorted-created-1" }));
	const updateFile = vi.fn(async () => ({ id: "f-1" }));
	const deleteFile = vi.fn(async () => {});

	const drive = {
		getFile,
		downloadFile,
		listFiles,
		createFile,
		updateFile,
		deleteFile,
	} as unknown as DrivePort;

	const storage: Pick<StoragePort, "upload" | "remove" | "publicUrl"> = {
		upload: vi.fn(async (bucket, path, body, opts) => {
			uploads.push({ bucket, path, body, contentType: opts.contentType });
		}),
		remove: vi.fn(async (bucket, paths) => {
			removed.push({ bucket, paths });
		}),
		publicUrl: (bucket, path) => `https://example.supabase.co/storage/v1/object/public/${bucket}/${path}`,
	};

	const artifacts: Pick<ArtifactRepository, "insert"> = {
		insert: vi.fn(async (row) => {
			insertedRows.push(row);
			return { id: row.id, title: row.title, created_at: "2026-03-12T00:00:00.000Z" };
		}),
	};

	const ports: DriveImportFilePorts = {
		drive,
		storage,
		artifacts,
		ownerId: OWNER_ID,
		storageBucket: "user-uploads",
		embedArtifact: vi.fn(async (id, fields) => {
			embedded.push({ id, fields });
		}),
	};

	return { ports, drive: { getFile, downloadFile, listFiles, createFile, updateFile, deleteFile }, storage, artifacts, insertedRows, uploads, removed, embedded };
}

afterEach(() => {
	setActionApprovalStore(undefined);
	vi.restoreAllMocks();
});

describe("createDriveImportFileAction (#1613)", () => {
	it("imports textual file with default account and cleanup omitted/none, stamping surface, origination, fields masks, and embedding", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);
		const fx = makeFixture({
			folderMeta: {
				"folder-1": { id: "folder-1", name: "Receipts", parents: ["folder-root"], mimeType: FOLDER_MIME_TYPE },
				"folder-root": { id: "folder-root", name: "Archive", parents: ["root"], mimeType: FOLDER_MIME_TYPE },
			},
		});
		const action = createDriveImportFileAction(fx.ports);
		expect(action.annotations.destructiveHint).toBe(true);

		const out = await executeAction(action, { file_id: "f-1", tags: ["tax"] });

		expect(fx.drive.getFile).toHaveBeenNthCalledWith(1, {
			domain: "angus",
			fileId: "f-1",
			fields: IMPORT_FILE_FIELDS,
		});
		expect(fx.drive.getFile).toHaveBeenNthCalledWith(2, {
			domain: "angus",
			fileId: "folder-1",
			fields: FOLDER_PATH_FIELDS,
		});
		expect(fx.drive.getFile).toHaveBeenNthCalledWith(3, {
			domain: "angus",
			fileId: "folder-root",
			fields: FOLDER_PATH_FIELDS,
		});
		expect(fx.insertedRows[0]).toMatchObject({
			id: FIXED_UUID,
			user_id: OWNER_ID,
			storage_bucket: "user-uploads",
			storage_path: `drive-imports/${OWNER_ID}/${FIXED_UUID}.txt`,
			surface: ARTIFACT_SURFACES.driveImport,
			source_channel: "google_drive",
			originated_at: "2026-03-10T09:00:00.000Z",
			source_parent_folder_ids: ["folder-1"],
			source_parent_folder_path: "Archive / Receipts",
			processing_status: "completed",
			plain_text: "hello world",
			tags: ["tax"],
		});
		expect(fx.embedded).toEqual([
			{ id: FIXED_UUID, fields: { title: "Notes.txt", plain_text: "hello world" } },
		]);
		expect(fx.drive.updateFile).not.toHaveBeenCalled();
		expect(fx.drive.deleteFile).not.toHaveBeenCalled();
		expect(formatDriveImportFileMcp(out)).toBe(
			`Imported "Notes.txt" from Drive as artifact ${FIXED_UUID}.\n` +
				`Stored 11 bytes (text/plain) at user-uploads/drive-imports/${OWNER_ID}/${FIXED_UUID}.txt.\n` +
				"Text stored and searchable now.",
		);
	});

	it("imports binary PDF on work domain with cleanup='move', renames, creates Sorted/, and renders artifact_extract_text next step", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);
		const fx = makeFixture({
			fileMeta: { name: "Scan.pdf", mimeType: "application/pdf", parents: ["parent-9"] },
			folderMeta: {
				"parent-9": { id: "parent-9", name: "Inbox", parents: ["root"], mimeType: FOLDER_MIME_TYPE },
			},
			downloaded: { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "application/pdf", extension: null },
		});
		const action = createDriveImportFileAction(fx.ports);

		const out = await executeAction(action, {
			file_id: "f-pdf",
			title: "2026-03-10 Acme Invoice",
			cleanup: "move",
			domain: "work",
		});

		expect(fx.embedded).toEqual([]);
		expect(fx.insertedRows[0]?.processing_status).toBe("pending");
		expect(fx.insertedRows[0]?.plain_text).toBeNull();
		expect(fx.drive.listFiles).toHaveBeenCalledWith({
			domain: "work",
			q: `name = 'Sorted' and mimeType = '${FOLDER_MIME_TYPE}' and 'parent-9' in parents and trashed = false`,
			fields: "files(id)",
		});
		expect(fx.drive.createFile).toHaveBeenCalledWith({
			domain: "work",
			name: "Sorted",
			mimeType: FOLDER_MIME_TYPE,
			parents: ["parent-9"],
			fields: "id",
		});
		expect(fx.drive.updateFile).toHaveBeenNthCalledWith(1, {
			domain: "work",
			fileId: "f-pdf",
			name: "2026-03-10 Acme Invoice",
			fields: "id",
		});
		expect(fx.drive.updateFile).toHaveBeenNthCalledWith(2, {
			domain: "work",
			fileId: "f-pdf",
			addParents: "sorted-created-1",
			removeParents: "parent-9",
			fields: "id",
		});
		expect(formatDriveImportFileMcp(out)).toBe(
			`Imported "2026-03-10 Acme Invoice" from Drive as artifact ${FIXED_UUID}.\n` +
				`Stored 4 bytes (application/pdf) at user-uploads/drive-imports/${OWNER_ID}/${FIXED_UUID}.pdf.\n` +
				"Binary stored \u2014 call artifact_extract_text with this id to make it searchable.\n" +
				'Renamed Drive file to "2026-03-10 Acme Invoice".\n' +
				"Moved Drive original to Sorted/ (sorted-created-1).",
		);
	});

	it("renders dev's warning when cleanup='move' and the Drive file has no parent", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);
		const fx = makeFixture({ fileMeta: { parents: [] } });
		const action = createDriveImportFileAction(fx.ports);

		const out = await executeAction(action, { file_id: "f-orphan", cleanup: "move" });

		expect(fx.drive.listFiles).not.toHaveBeenCalled();
		expect(formatDriveImportFileMcp(out)).toContain(
			"Warning: Drive file has no parent \u2014 skipped move to Sorted/.",
		);
	});

	it("parks cleanup='delete' from caller mcp with zero Drive/Storage/DB writes before approval, and deletes after approval", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);
		const fx = makeFixture({ fileMeta: { parents: [] } });
		const action = createDriveImportFileAction(fx.ports);
		setActionApprovalStore({ park: async () => ({ decisionId: "dec-42" }) });

		const args = { file_id: "f-del", cleanup: "delete" as const };
		let caught: unknown;
		try {
			await executeAction(action, args, {
				context: { caller: "mcp", requestId: "req-1" },
			});
		} catch (err) {
			caught = err;
		}
		expect(isPendingApproval(caught)).toBe(true);
		expect(fx.drive.getFile).not.toHaveBeenCalled();
		expect(fx.uploads).toHaveLength(0);
		expect(fx.insertedRows).toHaveLength(0);
		expect(fx.drive.deleteFile).not.toHaveBeenCalled();

		// Direct owner/ui call executes immediately and permanently deletes the original.
		const out = await executeAction(action, args, {
			context: { caller: "ui", userId: OWNER_ID },
		});
		expect(fx.drive.deleteFile).toHaveBeenCalledWith("angus", "f-del");
		expect(formatDriveImportFileMcp(out)).toContain("Permanently deleted Drive original f-del.");
	});

	it("refuses folders with dev's exact error, cleans up storage on DB failure, and preserves DriveApiError status/reason", async () => {
		const folderFx = makeFixture({ fileMeta: { mimeType: FOLDER_MIME_TYPE } });
		const folderAction = createDriveImportFileAction(folderFx.ports);
		await expect(executeAction(folderAction, { file_id: "folder-99" })).rejects.toThrow(
			"folder-99 is a folder \u2014 import individual files instead.",
		);

		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);
		const dbFailFx = makeFixture({ fileMeta: { parents: [] } });
		vi.mocked(dbFailFx.artifacts.insert).mockRejectedValueOnce(new Error("duplicate key"));
		const dbFailAction = createDriveImportFileAction(dbFailFx.ports);
		await expect(executeAction(dbFailAction, { file_id: "f-1" })).rejects.toThrow(
			"Insert failed: duplicate key",
		);
		expect(dbFailFx.removed).toEqual([
			{ bucket: "user-uploads", paths: [`drive-imports/${OWNER_ID}/${FIXED_UUID}.txt`] },
		]);

		const apiErrFx = makeFixture();
		const driveErr = new DriveApiError("Not found", 404, "notFound");
		apiErrFx.drive.getFile.mockRejectedValueOnce(driveErr);
		const apiErrAction = createDriveImportFileAction(apiErrFx.ports);
		await expect(executeAction(apiErrAction, { file_id: "missing" })).rejects.toMatchObject({
			status: 404,
			reason: "notFound",
		});
	});
});

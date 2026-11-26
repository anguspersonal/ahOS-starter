import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import { DriveApiError, FOLDER_MIME_TYPE, type DrivePort } from "../../ports/drive.js";
import type { ArtifactInsertRow, ArtifactRepository } from "../../ports/artifacts.js";
import type { StoragePort } from "../../ports/storage.js";
import { executeAction } from "../adapters/direct.js";
import { FOLDER_PATH_FIELDS, IMPORT_FILE_FIELDS } from "./importFile.js";
import {
	createIngestDriveAction,
	formatIngestDriveMcp,
	type DriveArtifactLookup,
	type IngestDrivePorts,
} from "./ingest.js";

const FIXED_UUID = "11111111-2222-4333-8444-555555555555";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";

function makeFixture(overrides?: {
	existing?: DriveArtifactLookup | null;
	fileMeta?: Record<string, unknown>;
	folderMeta?: Record<string, Record<string, unknown>>;
	downloaded?: { bytes: Uint8Array; mimeType: string; extension: string | null };
}) {
	const insertedRows: ArtifactInsertRow[] = [];
	const uploads: Array<{ bucket: string; path: string; body: string | Uint8Array; contentType: string }> = [];
	const removed: Array<{ bucket: string; paths: string[] }> = [];
	const embedded: Array<{ id: string; fields: Record<string, unknown> }> = [];

	const findArtifactByDriveFileId = vi.fn(async () => overrides?.existing ?? null);

	const getFile = vi.fn(async ({ fileId }: { fileId: string; fields?: string }) => {
		if (overrides?.folderMeta && fileId in overrides.folderMeta) {
			return overrides.folderMeta[fileId] as any;
		}
		return {
			id: fileId,
			name: "New Document.txt",
			mimeType: "text/plain",
			webViewLink: `https://drive.google.com/file/d/${fileId}`,
			parents: [],
			createdTime: "2026-03-10T09:00:00.000Z",
			modifiedTime: "2026-03-11T10:00:00.000Z",
			...overrides?.fileMeta,
		} as any;
	});

	const downloadFile = vi.fn(
		async () =>
			overrides?.downloaded ?? {
				bytes: new TextEncoder().encode("Hello world text"),
				mimeType: "text/plain",
				extension: null,
			},
	);

	const drive: Pick<DrivePort, "getFile" | "downloadFile"> = {
		getFile,
		downloadFile,
	};

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

	const ports: IngestDrivePorts = {
		drive,
		storage,
		artifacts,
		findArtifactByDriveFileId,
		ownerId: OWNER_ID,
		storageBucket: "kms",
		embedArtifact: vi.fn(async (id, fields) => {
			embedded.push({ id, fields });
		}),
	};

	return {
		ports,
		findArtifactByDriveFileId,
		drive: { getFile, downloadFile },
		storage,
		artifacts,
		insertedRows,
		uploads,
		removed,
		embedded,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createIngestDriveAction (#1614)", () => {
	it("reuses an already-ingested artifact for the same Drive file without re-importing", async () => {
		const fx = makeFixture({
			existing: {
				id: "existing-art-1",
				title: "Existing Doc",
				storage_bucket: "kms",
				storage_path: "drive-imports/user/file.txt",
				source_url: "https://drive.google.com/file/d/drive-file-123",
				source_parent_folder_ids: ["parent-folder-1"],
				source_parent_folder_path: "Team / Projects",
				processing_status: "completed",
				plain_text: "Existing plain text content",
			},
		});
		const action = createIngestDriveAction(fx.ports);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});

		const out = await executeAction(action, { file_id: "drive-file-123" });

		expect(fx.findArtifactByDriveFileId).toHaveBeenCalledWith("drive-file-123");
		expect(fx.drive.getFile).not.toHaveBeenCalled();
		expect(fx.drive.downloadFile).not.toHaveBeenCalled();
		expect(fx.storage.upload).not.toHaveBeenCalled();
		expect(fx.artifacts.insert).not.toHaveBeenCalled();
		expect(fx.embedded).toHaveLength(0);

		expect(formatIngestDriveMcp(out)).toBe(
			[
				"Drive file drive-file-123 already ingested as artifact existing-art-1.",
				"Title: Existing Doc",
				"Source URL: https://drive.google.com/file/d/drive-file-123",
				"Parent folder ids: parent-folder-1",
				"Parent folder path: Team / Projects",
				"Stored at: kms/drive-imports/user/file.txt",
				"Status: completed",
				"Existing artifact reused rather than re-capturing.",
			].join("\n"),
		);
	});

	it("imports and embeds when Drive file is not yet ingested, asserting fields masks and provenance", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);
		const fx = makeFixture({
			fileMeta: {
				name: "New Document",
				parents: ["folder-1"],
			},
			folderMeta: {
				"folder-1": { id: "folder-1", name: "Projects", parents: ["root"], mimeType: FOLDER_MIME_TYPE },
			},
		});
		const action = createIngestDriveAction(fx.ports);

		const out = await executeAction(action, { file_id: "drive-file-456", tags: ["ops"] });

		expect(fx.findArtifactByDriveFileId).toHaveBeenCalledWith("drive-file-456");
		expect(fx.drive.getFile).toHaveBeenNthCalledWith(1, {
			domain: "angus",
			fileId: "drive-file-456",
			fields: IMPORT_FILE_FIELDS,
		});
		expect(fx.drive.getFile).toHaveBeenNthCalledWith(2, {
			domain: "angus",
			fileId: "folder-1",
			fields: FOLDER_PATH_FIELDS,
		});
		expect(fx.insertedRows[0]).toMatchObject({
			id: FIXED_UUID,
			user_id: OWNER_ID,
			storage_bucket: "kms",
			storage_path: `drive-imports/${OWNER_ID}/${FIXED_UUID}`,
			surface: ARTIFACT_SURFACES.driveImport,
			source_channel: "google_drive",
			source_drive_file_id: "drive-file-456",
			source_parent_folder_ids: ["folder-1"],
			source_parent_folder_path: "Projects",
			processing_status: "completed",
			plain_text: "Hello world text",
			tags: ["ops"],
		});
		expect(fx.embedded).toEqual([
			{
				id: FIXED_UUID,
				fields: { title: "New Document", plain_text: "Hello world text" },
			},
		]);
		expect(formatIngestDriveMcp(out)).toBe(
			[
				`Ingested Drive file drive-file-456 as artifact ${FIXED_UUID}.`,
				"Title: New Document",
				"Source URL: https://drive.google.com/file/d/drive-file-456",
				"Parent folder ids: folder-1",
				"Parent folder path: Projects",
				`Stored at: kms/drive-imports/${OWNER_ID}/${FIXED_UUID}`,
				"Status: completed",
				"Text stored and searchable now. If you extracted entities, call artifact_sync_entities next.",
			].join("\n"),
		);
	});

	it("stores binary files with pending status without embedding and routes work domain", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);
		const fx = makeFixture({
			fileMeta: { name: "Invoice.pdf", mimeType: "application/pdf", parents: [] },
			downloaded: {
				bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
				mimeType: "application/pdf",
				extension: null,
			},
		});
		const action = createIngestDriveAction(fx.ports);

		const out = await executeAction(action, { file_id: "pdf-1", domain: "work" });

		expect(fx.drive.getFile).toHaveBeenCalledWith({
			domain: "work",
			fileId: "pdf-1",
			fields: IMPORT_FILE_FIELDS,
		});
		expect(fx.embedded).toHaveLength(0);
		expect(out.processing_status).toBe("pending");
		expect(formatIngestDriveMcp(out)).toBe(
			[
				`Ingested Drive file pdf-1 as artifact ${FIXED_UUID}.`,
				"Title: Invoice.pdf",
				"Source URL: https://drive.google.com/file/d/pdf-1",
				"Parent folder ids: (none)",
				"Parent folder path: (root or unknown)",
				`Stored at: kms/drive-imports/${OWNER_ID}/${FIXED_UUID}.pdf`,
				"Status: pending",
				"Binary stored \u2014 call artifact_extract_text with this artifact id to make it searchable, then artifact_sync_entities if needed.",
			].join("\n"),
		);
	});

	it("rejects folders, rolls back storage on insert error, and propagates DriveApiError status/reason", async () => {
		const folderFx = makeFixture({
			fileMeta: { mimeType: FOLDER_MIME_TYPE, name: "Shared" },
		});
		await expect(
			executeAction(createIngestDriveAction(folderFx.ports), { file_id: "dir-1" }),
		).rejects.toThrow("dir-1 is a folder \u2014 import individual files instead.");

		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);
		const dbFailFx = makeFixture();
		(dbFailFx.artifacts.insert as any).mockRejectedValueOnce(new Error("unique violation"));
		await expect(
			executeAction(createIngestDriveAction(dbFailFx.ports), { file_id: "f-2" }),
		).rejects.toThrow("Insert failed: unique violation");
		expect(dbFailFx.removed).toEqual([
			{ bucket: "kms", paths: [`drive-imports/${OWNER_ID}/${FIXED_UUID}.txt`] },
		]);

		const apiErrFx = makeFixture();
		apiErrFx.drive.getFile.mockRejectedValueOnce(
			new DriveApiError("insufficient permissions", 403, "insufficientFilePermissions"),
		);
		await expect(
			executeAction(createIngestDriveAction(apiErrFx.ports), { file_id: "f-3" }),
		).rejects.toMatchObject({
			status: 403,
			reason: "insufficientFilePermissions",
		});
	});

	it("throws when findArtifactByDriveFileId port is not wired", async () => {
		const fx = makeFixture();
		delete fx.ports.findArtifactByDriveFileId;
		await expect(
			executeAction(createIngestDriveAction(fx.ports), { file_id: "f-4" }),
		).rejects.toThrow("Drive ingest findArtifactByDriveFileId port is not wired.");
	});
});

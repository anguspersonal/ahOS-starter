import { describe, expect, it, vi } from "vitest";
import { DriveApiError, FOLDER_MIME_TYPE, type DriveFile, type DrivePort } from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { createDriveCopyAction, createDriveCreateFolderAction } from "./createAndCopy.js";

const SAMPLE_FOLDER: DriveFile = {
	id: "folder-101",
	name: "Board Materials",
	mimeType: FOLDER_MIME_TYPE,
	modifiedTime: "2026-10-12T10:00:00Z",
	owners: [{ emailAddress: "owner@work.example.com" }],
};

const SAMPLE_COPY: DriveFile = {
	id: "copy-202",
	name: "Copy of Deck.pptx",
	mimeType: "application/vnd.google-apps.presentation",
	size: "4096",
	modifiedTime: "2026-10-12T11:00:00Z",
	owners: [{ emailAddress: "owner@work.example.com" }],
};

function makePort(overrides: Partial<DrivePort> = {}): DrivePort {
	return {
		getFile: vi.fn(),
		listFiles: vi.fn(),
		listPermissions: vi.fn(),
		createFile: vi.fn().mockResolvedValue(SAMPLE_FOLDER),
		copyFile: vi.fn().mockResolvedValue(SAMPLE_COPY),
		uploadFile: vi.fn(),
		downloadFile: vi.fn(),
		exportFile: vi.fn(),
		updateFile: vi.fn(),
		trashFile: vi.fn(),
		listRevisions: vi.fn(),
		getRevision: vi.fn(),
		downloadRevision: vi.fn(),
		updateRevision: vi.fn(),
		deleteRevision: vi.fn(),
		...overrides,
	};
}

describe("drive_create_folder and drive_copy core actions (#1591)", () => {
	it("drive_create_folder creates a folder at root and under a parent, rendering 'Created folder:' plus formatFile", async () => {
		const createFile = vi
			.fn()
			.mockResolvedValueOnce(SAMPLE_FOLDER)
			.mockResolvedValueOnce({ ...SAMPLE_FOLDER, id: "folder-102", parents: ["parent-9"] });
		const action = createDriveCreateFolderAction(makePort({ createFile }));

		const rootOut = await executeAction(
			action,
			{ name: "Board Materials" },
			{ context: { caller: "mcp" } },
		);
		const childOut = await executeAction(
			action,
			{ name: "Board Materials", parent_id: "parent-9", domain: "work" },
			{ context: { caller: "mcp" } },
		);

		expect(createFile).toHaveBeenNthCalledWith(1, {
			domain: "angus",
			name: "Board Materials",
			mimeType: FOLDER_MIME_TYPE,
		});
		expect(createFile).toHaveBeenNthCalledWith(2, {
			domain: "work",
			name: "Board Materials",
			mimeType: FOLDER_MIME_TYPE,
			parents: ["parent-9"],
		});
		expect(action.formatMcp!(rootOut)).toBe(
			"Created folder:\n• [folder-101] Board Materials (application/vnd.google-apps.folder, modified 2026-10-12T10:00:00Z, owner owner@work.example.com)",
		);
		expect(action.formatMcp!(childOut)).toBe(
			"Created folder:\n• [folder-102] Board Materials (application/vnd.google-apps.folder, modified 2026-10-12T10:00:00Z, owner owner@work.example.com)",
		);
	});

	it("drive_copy copies a file with name and parent and with neither, rendering 'Copied to:' plus formatFile", async () => {
		const copyFile = vi
			.fn()
			.mockResolvedValueOnce({ ...SAMPLE_COPY, name: "Q4 Deck.pptx", parents: ["dest-7"] })
			.mockResolvedValueOnce(SAMPLE_COPY);
		const action = createDriveCopyAction(makePort({ copyFile }));

		const withBoth = await executeAction(
			action,
			{ file_id: "src-1", name: "Q4 Deck.pptx", parent_id: "dest-7", domain: "work" },
			{ context: { caller: "mcp" } },
		);
		const withNeither = await executeAction(
			action,
			{ file_id: "src-1", account: "personal" },
			{ context: { caller: "mcp" } },
		);

		expect(copyFile).toHaveBeenNthCalledWith(1, {
			domain: "work",
			fileId: "src-1",
			name: "Q4 Deck.pptx",
			parents: ["dest-7"],
		});
		expect(copyFile).toHaveBeenNthCalledWith(2, {
			domain: "angus",
			fileId: "src-1",
		});
		expect(action.formatMcp!(withBoth)).toBe(
			"Copied to:\n• [copy-202] Q4 Deck.pptx (application/vnd.google-apps.presentation, 4096 bytes, modified 2026-10-12T11:00:00Z, owner owner@work.example.com)",
		);
		expect(action.formatMcp!(withNeither)).toBe(
			"Copied to:\n• [copy-202] Copy of Deck.pptx (application/vnd.google-apps.presentation, 4096 bytes, modified 2026-10-12T11:00:00Z, owner owner@work.example.com)",
		);
	});

	it("rejects conflicting domain and account and propagates DriveApiError status and reason", async () => {
		const err = new DriveApiError("Google Drive API error (HTTP 403): Insufficient permissions", 403, "insufficientFilePermissions", "PERMISSION_DENIED");
		const folderAction = createDriveCreateFolderAction(makePort({ createFile: vi.fn().mockRejectedValue(err) }));
		const copyAction = createDriveCopyAction(makePort({ copyFile: vi.fn().mockRejectedValue(err) }));

		await expect(
			executeAction(
				folderAction,
				{ name: "Test", domain: "work", account: "personal" },
				{ context: { caller: "mcp" } },
			),
		).rejects.toThrow(/name different domains/);

		await expect(
			executeAction(copyAction, { file_id: "src-1" }, { context: { caller: "mcp" } }),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 403,
			reason: "insufficientFilePermissions",
		});
	});
});

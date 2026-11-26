import { describe, expect, it, vi } from "vitest";
import { DriveApiError, type DriveFile, type DrivePort } from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { createDriveRenameAction, createDriveTrashAction } from "./renameAndTrash.js";

const SAMPLE_FILE: DriveFile = {
	id: "file-123",
	name: "Q4 Plan.docx",
	mimeType: "application/vnd.google-apps.document",
	size: "2048",
	modifiedTime: "2026-10-12T10:00:00Z",
	owners: [{ emailAddress: "owner@work.example.com" }],
};

function makePort(updateFile = vi.fn().mockResolvedValue(SAMPLE_FILE)): DrivePort {
	return {
		getFile: vi.fn(),
		listFiles: vi.fn(),
		listPermissions: vi.fn(),
		uploadFile: vi.fn(),
		downloadFile: vi.fn(),
		exportFile: vi.fn(),
		updateFile,
		trashFile: vi.fn(),
		listRevisions: vi.fn(),
		getRevision: vi.fn(),
		downloadRevision: vi.fn(),
		updateRevision: vi.fn(),
		deleteRevision: vi.fn(),
	};
}

describe("drive_rename and drive_trash core actions (#1481)", () => {
	it("drive_rename defaults domain to 'angus' and renders 'Renamed:' plus formatFile", async () => {
		const updateFile = vi.fn().mockResolvedValue(SAMPLE_FILE);
		const action = createDriveRenameAction(makePort(updateFile));
		const out = await executeAction(
			action,
			{ file_id: "file-123", name: "Q4 Plan.docx" },
			{ context: { caller: "mcp" } },
		);

		expect(updateFile).toHaveBeenCalledWith("angus", "file-123", { name: "Q4 Plan.docx" });
		expect(action.formatMcp!(out)).toBe(
			"Renamed:\n• [file-123] Q4 Plan.docx (application/vnd.google-apps.document, 2048 bytes, modified 2026-10-12T10:00:00Z, owner owner@work.example.com)",
		);
	});

	it("drive_trash sends trashed: true by default and trashed: false when restore: true, rendering Trashed: and Restored:", async () => {
		const updateFile = vi
			.fn()
			.mockResolvedValueOnce({ ...SAMPLE_FILE, trashed: true })
			.mockResolvedValueOnce({ ...SAMPLE_FILE, trashed: false });
		const action = createDriveTrashAction(makePort(updateFile));

		const trashedOut = await executeAction(
			action,
			{ file_id: "file-123", domain: "work" },
			{ context: { caller: "mcp" } },
		);
		const restoredOut = await executeAction(
			action,
			{ file_id: "file-123", account: "personal", restore: true },
			{ context: { caller: "mcp" } },
		);

		expect(updateFile).toHaveBeenNthCalledWith(1, "work", "file-123", { trashed: true });
		expect(updateFile).toHaveBeenNthCalledWith(2, "angus", "file-123", { trashed: false });
		expect(action.formatMcp!(trashedOut)).toBe(
			"Trashed:\n• [file-123] Q4 Plan.docx (application/vnd.google-apps.document, 2048 bytes, modified 2026-10-12T10:00:00Z, TRASHED, owner owner@work.example.com)",
		);
		expect(action.formatMcp!(restoredOut)).toBe(
			"Restored:\n• [file-123] Q4 Plan.docx (application/vnd.google-apps.document, 2048 bytes, modified 2026-10-12T10:00:00Z, owner owner@work.example.com)",
		);
	});

	it("rejects conflicting domain and account and propagates DriveApiError status and reason", async () => {
		const updateFile = vi.fn().mockRejectedValue(
			new DriveApiError("Google Drive API error (HTTP 404): File not found", 404, "notFound", "NOT_FOUND"),
		);
		const renameAction = createDriveRenameAction(makePort(updateFile));
		const trashAction = createDriveTrashAction(makePort(updateFile));

		await expect(
			executeAction(
				renameAction,
				{ file_id: "file-123", name: "New", domain: "work", account: "personal" },
				{ context: { caller: "mcp" } },
			),
		).rejects.toThrow(/name different domains/);

		await expect(
			executeAction(trashAction, { file_id: "missing-id" }, { context: { caller: "mcp" } }),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 404,
			reason: "notFound",
		});
	});
});

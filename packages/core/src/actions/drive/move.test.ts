import { describe, expect, it, vi } from "vitest";
import {
	DriveApiError,
	FILE_FIELDS,
	type DriveFile,
	type DrivePort,
} from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { createDriveMoveAction } from "./move.js";

const SAMPLE_FILE: DriveFile = {
	id: "file-123",
	name: "Q4 Plan.docx",
	mimeType: "application/vnd.google-apps.document",
	size: "2048",
	modifiedTime: "2026-10-12T10:00:00Z",
	parents: ["folder-dest"],
	owners: [{ emailAddress: "owner@work.example.com" }],
};

function makePort(
	getFile = vi.fn().mockResolvedValue({ parents: ["folder-old"] }),
	updateFile = vi.fn().mockResolvedValue(SAMPLE_FILE),
): DrivePort {
	return {
		getFile,
		listFiles: vi.fn(),
		listPermissions: vi.fn(),
		createFile: vi.fn(),
		copyFile: vi.fn(),
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

describe("drive_move core action (#1488)", () => {
	it("moves a file with one parent by removing that parent and adding new_parent_id, rendering dev's 'Moved:' text", async () => {
		const getFile = vi.fn().mockResolvedValue({ parents: ["folder-old"] });
		const updateFile = vi.fn().mockResolvedValue(SAMPLE_FILE);
		const action = createDriveMoveAction(makePort(getFile, updateFile));

		const out = await executeAction(
			action,
			{ file_id: "file-123", new_parent_id: "folder-dest" },
			{ context: { caller: "mcp" } },
		);

		expect(getFile).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "file-123",
			fields: "parents",
		});
		expect(updateFile).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "file-123",
			addParents: "folder-dest",
			removeParents: "folder-old",
			fields: FILE_FIELDS,
		});
		expect(action.formatMcp!(out)).toBe(
			"Moved:\n• [file-123] Q4 Plan.docx (application/vnd.google-apps.document, 2048 bytes, modified 2026-10-12T10:00:00Z, owner owner@work.example.com)",
		);
	});

	it("sends no removeParents when a file has no parents and joins multiple parents with commas", async () => {
		const getFile = vi
			.fn()
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ parents: ["p-1", "p-2"] });
		const updateFile = vi.fn().mockResolvedValue(SAMPLE_FILE);
		const action = createDriveMoveAction(makePort(getFile, updateFile));

		await executeAction(
			action,
			{ file_id: "file-123", new_parent_id: "folder-dest", domain: "work" },
			{ context: { caller: "mcp" } },
		);
		await executeAction(
			action,
			{ file_id: "file-123", new_parent_id: "folder-dest", account: "personal" },
			{ context: { caller: "mcp" } },
		);

		expect(updateFile).toHaveBeenNthCalledWith(1, {
			domain: "work",
			fileId: "file-123",
			addParents: "folder-dest",
			removeParents: undefined,
			fields: FILE_FIELDS,
		});
		expect(updateFile).toHaveBeenNthCalledWith(2, {
			domain: "angus",
			fileId: "file-123",
			addParents: "folder-dest",
			removeParents: "p-1,p-2",
			fields: FILE_FIELDS,
		});
	});

	it("rejects conflicting domain and account and propagates DriveApiError status and reason", async () => {
		const getFile = vi.fn().mockRejectedValue(
			new DriveApiError(
				"Google Drive API error (HTTP 404): File not found",
				404,
				"notFound",
				"NOT_FOUND",
			),
		);
		const action = createDriveMoveAction(makePort(getFile));

		await expect(
			executeAction(
				action,
				{
					file_id: "file-123",
					new_parent_id: "folder-dest",
					domain: "work",
					account: "personal",
				},
				{ context: { caller: "mcp" } },
			),
		).rejects.toThrow(/name different domains/);

		await expect(
			executeAction(
				action,
				{ file_id: "missing-id", new_parent_id: "folder-dest" },
				{ context: { caller: "mcp" } },
			),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 404,
			reason: "notFound",
		});
	});
});

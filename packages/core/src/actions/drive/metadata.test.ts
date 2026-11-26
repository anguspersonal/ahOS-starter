import { describe, expect, it, vi } from "vitest";
import {
	DriveApiError,
	FILE_FIELDS,
	PERMISSION_FIELDS,
	type DriveFile,
	type DrivePermission,
	type DrivePort,
} from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import {
	createDriveGetMetadataAction,
	createDriveListPermissionsAction,
} from "./metadata.js";

const SHARED_FILE_WITH_PARENTS: DriveFile = {
	id: "file-shared-1",
	name: "Q4 Strategy.docx",
	mimeType: "application/vnd.google-apps.document",
	size: "4096",
	modifiedTime: "2026-10-12T10:00:00Z",
	createdTime: "2026-10-01T09:00:00Z",
	owners: [{ emailAddress: "owner@work.example.com" }],
	parents: ["folder-a", "folder-b"],
	webViewLink: "https://docs.google.com/document/d/file-shared-1/edit",
	shared: true,
};

const BARE_FILE: DriveFile = {
	id: "file-bare-2",
	name: "Scratchpad",
	mimeType: "text/plain",
};

function makePort(overrides?: Partial<DrivePort>): DrivePort {
	return {
		getFile: vi.fn().mockResolvedValue(SHARED_FILE_WITH_PARENTS),
		listFiles: vi.fn(),
		listPermissions: vi.fn().mockResolvedValue([]),
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

describe("drive_get_metadata and drive_list_permissions core actions (#1587)", () => {
	it("drive_get_metadata renders byte-identical metadata text for a shared file with parents and for a bare file, defaulting account to personal ('angus')", async () => {
		const getFile = vi
			.fn()
			.mockResolvedValueOnce(SHARED_FILE_WITH_PARENTS)
			.mockResolvedValueOnce(BARE_FILE);
		const action = createDriveGetMetadataAction(makePort({ getFile }));

		const sharedOut = await executeAction(
			action,
			{ file_id: "file-shared-1" },
			{ context: { caller: "mcp" } },
		);
		const bareOut = await executeAction(
			action,
			{ file_id: "file-bare-2", domain: "work" },
			{ context: { caller: "mcp" } },
		);

		expect(getFile).toHaveBeenNthCalledWith(1, {
			domain: "angus",
			fileId: "file-shared-1",
			fields: FILE_FIELDS,
		});
		expect(getFile).toHaveBeenNthCalledWith(2, {
			domain: "work",
			fileId: "file-bare-2",
			fields: FILE_FIELDS,
		});

		expect(action.formatMcp!(sharedOut)).toBe(
			[
				"• [file-shared-1] Q4 Strategy.docx (application/vnd.google-apps.document, 4096 bytes, modified 2026-10-12T10:00:00Z, owner owner@work.example.com)",
				"Link: https://docs.google.com/document/d/file-shared-1/edit",
				"Parents: folder-a, folder-b",
				"Created: 2026-10-01T09:00:00Z",
				"Shared: true",
			].join("\n"),
		);

		expect(action.formatMcp!(bareOut)).toBe("• [file-bare-2] Scratchpad (text/plain)");
	});

	it("drive_list_permissions returns 'Drive returned no permissions.' when empty and renders permission lines when populated", async () => {
		const twoPermissions: DrivePermission[] = [
			{
				id: "perm-1",
				type: "user",
				role: "owner",
				emailAddress: "owner@work.example.com",
			},
			{
				id: "perm-2",
				type: "domain",
				role: "reader",
				domain: "work.example.com",
			},
		];
		const listPermissions = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(twoPermissions);
		const action = createDriveListPermissionsAction(makePort({ listPermissions }));

		const emptyOut = await executeAction(
			action,
			{ file_id: "file-bare-2" },
			{ context: { caller: "mcp" } },
		);
		const populatedOut = await executeAction(
			action,
			{ file_id: "file-shared-1", account: "work" },
			{ context: { caller: "mcp" } },
		);

		expect(listPermissions).toHaveBeenNthCalledWith(1, {
			domain: "angus",
			fileId: "file-bare-2",
			fields: PERMISSION_FIELDS,
		});
		expect(listPermissions).toHaveBeenNthCalledWith(2, {
			domain: "work",
			fileId: "file-shared-1",
			fields: PERMISSION_FIELDS,
		});

		expect(action.formatMcp!(emptyOut)).toBe("Drive returned no permissions.");
		expect(action.formatMcp!(populatedOut)).toBe(
			"2 permission(s):\n• [perm-1] owner — user owner@work.example.com\n• [perm-2] reader — domain work.example.com",
		);
	});

	it("rejects conflicting domain and account and propagates DriveApiError status and reason", async () => {
		const apiErr = new DriveApiError(
			"Google Drive API error (HTTP 404): File not found",
			404,
			"notFound",
			"NOT_FOUND",
		);
		const port = makePort({
			getFile: vi.fn().mockRejectedValue(apiErr),
			listPermissions: vi.fn().mockRejectedValue(apiErr),
		});
		const getMetaAction = createDriveGetMetadataAction(port);
		const listPermsAction = createDriveListPermissionsAction(port);

		await expect(
			executeAction(
				getMetaAction,
				{ file_id: "file-1", domain: "work", account: "personal" },
				{ context: { caller: "mcp" } },
			),
		).rejects.toThrow(/name different domains/);

		await expect(
			executeAction(getMetaAction, { file_id: "missing-id" }, { context: { caller: "mcp" } }),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 404,
			reason: "notFound",
		});

		await expect(
			executeAction(listPermsAction, { file_id: "missing-id" }, { context: { caller: "mcp" } }),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 404,
			reason: "notFound",
		});
	});
});

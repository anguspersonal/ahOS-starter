import { describe, expect, it, vi } from "vitest";
import {
	DriveApiError,
	formatList,
	LIST_FIELDS,
	type DriveFile,
	type DrivePort,
} from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import {
	createDriveListAction,
	createDriveSearchAction,
} from "./list.js";

const SAMPLE_FILE: DriveFile = {
	id: "file1",
	name: "Doc1",
	mimeType: "text/plain",
	size: "100",
	modifiedTime: "2026-10-10T10:00:00Z",
};

function makePort(
	listFiles = vi.fn().mockResolvedValue({ files: [SAMPLE_FILE] }),
): DrivePort {
	return {
		getFile: vi.fn(),
		listFiles,
		listPermissions: vi.fn(),
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
	};
}

describe("drive_list and drive_search core actions (#1588, carrying #1439 cursor)", () => {
	it("drive_list prints the cursor and says the list is incomplete when Drive returns nextPageToken", async () => {
		const listFiles = vi.fn().mockResolvedValueOnce({
			files: [SAMPLE_FILE],
			nextPageToken: "token123",
		});
		const action = createDriveListAction(makePort(listFiles));
		const out = await executeAction(action, {}, { context: { caller: "mcp" } });
		const text = action.formatMcp!(out);

		expect(listFiles).toHaveBeenCalledWith({
			domain: "angus",
			q: "trashed = false",
			pageSize: 25,
			orderBy: "modifiedTime desc",
			pageToken: undefined,
			fields: LIST_FIELDS,
		});
		expect(text).toContain(
			"More files exist. Call drive_list again with the same arguments plus cursor 'token123' for the next page; do not treat this list as complete.",
		);
	});

	it("drive_list sends cursor as pageToken and includes incompleteSearch in fields", async () => {
		const listFiles = vi.fn().mockResolvedValueOnce({
			files: [SAMPLE_FILE],
		});
		const action = createDriveListAction(makePort(listFiles));
		await executeAction(
			action,
			{ cursor: "cursor_abc" },
			{ context: { caller: "mcp" } },
		);

		expect(listFiles).toHaveBeenCalledTimes(1);
		expect(listFiles.mock.calls[0][0].pageToken).toBe("cursor_abc");
		expect(listFiles.mock.calls[0][0].fields).toContain("incompleteSearch");
	});

	it("drive_search sends cursor as pageToken and prints the next cursor", async () => {
		const listFiles = vi.fn().mockResolvedValueOnce({
			files: [SAMPLE_FILE],
			nextPageToken: "search_next_token",
		});
		const action = createDriveSearchAction(makePort(listFiles));
		const out = await executeAction(
			action,
			{ query: "report", cursor: "search_cursor_1" },
			{ context: { caller: "mcp" } },
		);

		expect(listFiles).toHaveBeenCalledTimes(1);
		expect(listFiles.mock.calls[0][0].pageToken).toBe("search_cursor_1");
		expect(listFiles.mock.calls[0][0].fields).toContain("incompleteSearch");

		const text = action.formatMcp!(out);
		expect(text).toContain(
			"More files exist. Call drive_search again with the same arguments plus cursor 'search_next_token' for the next page; do not treat this list as complete.",
		);
	});

	it("an empty page that carries nextPageToken still prints the cursor", async () => {
		const listFiles = vi.fn().mockResolvedValueOnce({
			files: [],
			nextPageToken: "empty_next_tok",
		});
		const action = createDriveListAction(makePort(listFiles));
		const out = await executeAction(action, {}, { context: { caller: "mcp" } });
		const text = action.formatMcp!(out);

		expect(text).toContain("No files.");
		expect(text).toContain(
			"More files exist. Call drive_list again with the same arguments plus cursor 'empty_next_tok' for the next page; do not treat this list as complete.",
		);
	});

	it("drive_list wraps q in parentheses and ANDs it with the folder and trashed clauses", async () => {
		const listFiles = vi.fn().mockResolvedValueOnce({
			files: [SAMPLE_FILE],
		});
		const action = createDriveListAction(makePort(listFiles));
		await executeAction(
			action,
			{ q: "name = 'test.txt'", folder_id: "folder123" },
			{ context: { caller: "mcp" } },
		);

		expect(listFiles).toHaveBeenCalledTimes(1);
		expect(listFiles.mock.calls[0][0].q).toBe(
			"(name = 'test.txt') and 'folder123' in parents and trashed = false",
		);
	});

	it("a last page prints byte-identical text to formatList", async () => {
		const listFiles = vi.fn().mockResolvedValueOnce({
			files: [SAMPLE_FILE],
		});
		const action = createDriveListAction(makePort(listFiles));
		const out = await executeAction(action, {}, { context: { caller: "mcp" } });
		const text = action.formatMcp!(out);

		expect(text).toBe(formatList([SAMPLE_FILE]));
	});

	it("says files may be missing when Drive returns incompleteSearch", async () => {
		const listFiles = vi.fn().mockResolvedValueOnce({
			files: [SAMPLE_FILE],
			incompleteSearch: true,
		});
		const action = createDriveSearchAction(makePort(listFiles));
		const out = await executeAction(
			action,
			{ query: "report" },
			{ context: { caller: "mcp" } },
		);
		const text = action.formatMcp!(out);

		expect(text).toContain(
			"Drive searched only part of the corpus; results may be missing.",
		);
	});

	it("escapes single quotes and backslashes in drive_search query and mime_type and respects include_trashed", async () => {
		const listFiles = vi.fn().mockResolvedValueOnce({
			files: [SAMPLE_FILE],
		});
		const action = createDriveSearchAction(makePort(listFiles));
		await executeAction(
			action,
			{
				query: "angus's \\notes",
				mime_type: "application/pdf",
				include_trashed: true,
				page_size: 100,
				domain: "work",
			},
			{ context: { caller: "mcp" } },
		);

		expect(listFiles).toHaveBeenCalledWith({
			domain: "work",
			q: "(fullText contains 'angus\\'s \\\\notes' or name contains 'angus\\'s \\\\notes') and mimeType = 'application/pdf'",
			pageSize: 100,
			orderBy: "modifiedTime desc",
			pageToken: undefined,
			fields: LIST_FIELDS,
		});
	});

	it("enforces page_size cap of 100, reconciles account/domain, and propagates DriveApiError", async () => {
		const listFiles = vi
			.fn()
			.mockRejectedValue(
				new DriveApiError(
					"Google Drive API error (HTTP 403): Insufficient Permission",
					403,
					"insufficientPermissions",
					"PERMISSION_DENIED",
				),
			);
		const listAction = createDriveListAction(makePort(listFiles));
		const searchAction = createDriveSearchAction(makePort(listFiles));

		await expect(
			executeAction(
				listAction,
				{ page_size: 101 } as any,
				{ context: { caller: "mcp" } },
			),
		).rejects.toThrow();

		await expect(
			executeAction(
				searchAction,
				{ query: "report", page_size: 0 } as any,
				{ context: { caller: "mcp" } },
			),
		).rejects.toThrow();

		await expect(
			executeAction(
				listAction,
				{ domain: "work", account: "personal" },
				{ context: { caller: "mcp" } },
			),
		).rejects.toThrow(/name different domains/);

		await expect(
			executeAction(
				searchAction,
				{ query: "report" },
				{ context: { caller: "mcp" } },
			),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 403,
			reason: "insufficientPermissions",
			googleStatus: "PERMISSION_DENIED",
		});
	});
});

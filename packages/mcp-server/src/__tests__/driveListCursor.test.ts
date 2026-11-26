import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatList,
	type DriveFile,
	type DrivePort,
} from "@ahkms/core";
import {
	createDriveListAction,
	createDriveSearchAction,
} from "@ahkms/core/actions";
import { toMcpTool } from "../actions/adapters/mcp.js";

const listFiles = vi.fn();

const fakeDrivePort: DrivePort = {
	getFile: vi.fn(),
	listFiles,
	listPermissions: vi.fn(),
	createFile: vi.fn(),
	copyFile: vi.fn(),
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

const driveListHandler = toMcpTool(createDriveListAction(fakeDrivePort)).handler;
const driveSearchHandler = toMcpTool(createDriveSearchAction(fakeDrivePort)).handler;

const sampleFile: DriveFile = {
	id: "file1",
	name: "Doc1",
	mimeType: "text/plain",
	size: "100",
	modifiedTime: "2026-10-10T10:00:00Z",
};

describe("drive list and search pagination & query", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("drive_list prints the cursor and says the list is incomplete when Drive returns nextPageToken", async () => {
		listFiles.mockResolvedValueOnce({
			files: [sampleFile],
			nextPageToken: "token123",
		});

		const res = await driveListHandler({});
		const text = res.content[0].text;
		expect(text).toContain(
			"More files exist. Call drive_list again with the same arguments plus cursor 'token123' for the next page; do not treat this list as complete.",
		);
	});

	it("drive_list sends cursor as pageToken", async () => {
		listFiles.mockResolvedValueOnce({
			files: [sampleFile],
		});

		await driveListHandler({ cursor: "cursor_abc" });
		expect(listFiles).toHaveBeenCalledTimes(1);
		expect(listFiles.mock.calls[0][0].pageToken).toBe("cursor_abc");
		expect(listFiles.mock.calls[0][0].fields).toContain("incompleteSearch");
	});

	it("drive_search sends cursor as pageToken and prints the next cursor", async () => {
		listFiles.mockResolvedValueOnce({
			files: [sampleFile],
			nextPageToken: "search_next_token",
		});

		const res = await driveSearchHandler({ query: "report", cursor: "search_cursor_1" });
		expect(listFiles).toHaveBeenCalledTimes(1);
		expect(listFiles.mock.calls[0][0].pageToken).toBe("search_cursor_1");
		expect(listFiles.mock.calls[0][0].fields).toContain("incompleteSearch");

		const text = res.content[0].text;
		expect(text).toContain(
			"More files exist. Call drive_search again with the same arguments plus cursor 'search_next_token' for the next page; do not treat this list as complete.",
		);
	});

	it("an empty page that carries nextPageToken still prints the cursor", async () => {
		listFiles.mockResolvedValueOnce({
			files: [],
			nextPageToken: "empty_next_tok",
		});

		const res = await driveListHandler({});
		const text = res.content[0].text;
		expect(text).toContain("No files.");
		expect(text).toContain(
			"More files exist. Call drive_list again with the same arguments plus cursor 'empty_next_tok' for the next page; do not treat this list as complete.",
		);
	});

	it("drive_list wraps q in parentheses and ANDs it with the folder and trashed clauses", async () => {
		listFiles.mockResolvedValueOnce({
			files: [sampleFile],
		});

		await driveListHandler({ q: "name = 'test.txt'", folder_id: "folder123" });
		expect(listFiles).toHaveBeenCalledTimes(1);
		expect(listFiles.mock.calls[0][0].q).toBe(
			"(name = 'test.txt') and 'folder123' in parents and trashed = false",
		);
	});

	it("a last page prints exactly today's text", async () => {
		listFiles.mockResolvedValueOnce({
			files: [sampleFile],
		});

		const res = await driveListHandler({});
		const text = res.content[0].text;
		expect(text).toBe(formatList([sampleFile]));
	});

	it("says files may be missing when Drive returns incompleteSearch", async () => {
		listFiles.mockResolvedValueOnce({
			files: [sampleFile],
			incompleteSearch: true,
		});

		const res = await driveSearchHandler({ query: "report" });
		const text = res.content[0].text;
		expect(text).toContain(
			"Drive searched only part of the corpus; results may be missing.",
		);
	});
});

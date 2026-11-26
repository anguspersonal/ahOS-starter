import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { createDriveChangesListAction } from "./changesList.js";
import { createGoogleDriveWatchAdapter } from "../../adapters/google/driveWatchAdapter.js";

describe("drive_changes_list (#1654)", () => {
	it("1. two pages of changes, the second carrying newStartPageToken: all changes returned, new_start_page_token set, next_cursor null", async () => {
		const listChanges = vi
			.fn()
			.mockResolvedValueOnce({
				changes: [
					{
						fileId: "file-1",
						removed: false,
						time: "2026-10-11T10:00:00.000Z",
						file: {
							id: "file-1",
							name: "Alpha.pdf",
							mimeType: "application/pdf",
							trashed: false,
						},
					},
				],
				nextPageToken: "page-2",
				newStartPageToken: null,
			})
			.mockResolvedValueOnce({
				changes: [
					{
						fileId: "file-2",
						removed: false,
						time: "2026-10-11T10:05:00.000Z",
						file: {
							id: "file-2",
							name: "Beta.docx",
							mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
							trashed: true,
						},
					},
				],
				nextPageToken: null,
				newStartPageToken: "start-token-99",
			});

		const action = createDriveChangesListAction({ listChanges });
		const out = await executeAction(action, {
			domain: "angus",
			cursor: "start-token-1",
		});

		expect(listChanges).toHaveBeenCalledTimes(2);
		expect(listChanges).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				account: "personal",
				pageToken: "start-token-1",
				includeRemoved: true,
				includeItemsFromAllDrives: true,
			}),
		);
		expect(listChanges).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				account: "personal",
				pageToken: "page-2",
				includeRemoved: true,
				includeItemsFromAllDrives: true,
			}),
		);
		expect(out).toEqual({
			changes: [
				{
					file_id: "file-1",
					removed: false,
					trashed: false,
					time: "2026-10-11T10:00:00.000Z",
					name: "Alpha.pdf",
					mime_type: "application/pdf",
				},
				{
					file_id: "file-2",
					removed: false,
					trashed: true,
					time: "2026-10-11T10:05:00.000Z",
					name: "Beta.docx",
					mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				},
			],
			next_cursor: null,
			new_start_page_token: "start-token-99",
		});
	});

	it("2. a removed: true change is returned with removed: true and no name", async () => {
		const listChanges = vi.fn().mockResolvedValueOnce({
			changes: [
				{
					fileId: "deleted-file-id",
					removed: true,
					time: "2026-10-11T11:00:00.000Z",
				},
			],
			nextPageToken: null,
			newStartPageToken: "start-token-100",
		});

		const action = createDriveChangesListAction({ listChanges });
		const out = await executeAction(action, {
			domain: "angus",
			cursor: "start-token-99",
		});

		expect(out).toEqual({
			changes: [
				{
					file_id: "deleted-file-id",
					removed: true,
					trashed: false,
					time: "2026-10-11T11:00:00.000Z",
				},
			],
			next_cursor: null,
			new_start_page_token: "start-token-100",
		});
		if ("changes" in out) {
			expect(out.changes[0].removed).toBe(true);
			expect(out.changes[0].name).toBeUndefined();
			expect("name" in out.changes[0]).toBe(false);
		}
	});

	it("3. a 400 Invalid Value on the token returns { expired: true }", async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("oauth2.googleapis.com/token")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ access_token: "mock-access-token" }),
				};
			}
			if (url.includes("drive/v3/changes")) {
				return {
					ok: false,
					status: 400,
					text: async () =>
						JSON.stringify({
							error: { code: 400, message: "Invalid Value", errors: [{ reason: "invalidParameter" }] },
						}),
				};
			}
			return { ok: false, status: 500, text: async () => "Unexpected" };
		});

		const adapter = createGoogleDriveWatchAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshTokens: { personal: "rt-personal" },
			fetchFn: mockFetch as unknown as typeof fetch,
		});

		const action = createDriveChangesListAction(adapter);
		const out = await executeAction(action, {
			domain: "angus",
			cursor: "stale-page-token",
		});

		expect(out).toEqual({ expired: true });
	});

	it("4. stops at limit when more pages remain and returns next_cursor", async () => {
		const listChanges = vi.fn().mockResolvedValueOnce({
			changes: [
				{
					fileId: "file-1",
					removed: false,
					time: "2026-10-11T10:00:00.000Z",
					file: { id: "file-1", name: "One.txt", mimeType: "text/plain", trashed: false },
				},
				{
					fileId: "file-2",
					removed: false,
					time: "2026-10-11T10:01:00.000Z",
					file: { id: "file-2", name: "Two.txt", mimeType: "text/plain", trashed: false },
				},
			],
			nextPageToken: "cursor-page-2",
			newStartPageToken: null,
		});

		const action = createDriveChangesListAction({ listChanges });
		const out = await executeAction(action, {
			domain: "work",
			cursor: "cursor-page-1",
			limit: 2,
		});

		expect(listChanges).toHaveBeenCalledTimes(1);
		expect(listChanges).toHaveBeenCalledWith(
			expect.objectContaining({ account: "work", pageToken: "cursor-page-1", pageSize: 2 }),
		);
		expect(out).toEqual({
			changes: [
				{
					file_id: "file-1",
					removed: false,
					trashed: false,
					time: "2026-10-11T10:00:00.000Z",
					name: "One.txt",
					mime_type: "text/plain",
				},
				{
					file_id: "file-2",
					removed: false,
					trashed: false,
					time: "2026-10-11T10:01:00.000Z",
					name: "Two.txt",
					mime_type: "text/plain",
				},
			],
			next_cursor: "cursor-page-2",
			new_start_page_token: null,
		});
	});
});

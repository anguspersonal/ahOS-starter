import { describe, expect, it, vi } from "vitest";
import { createGoogleDriveAdapter } from "../../adapters/google/drive/index.js";
import { DriveApiError, type DriveComment, type DrivePort } from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { createDocsCommentsAction } from "../docs/comments.js";
import { createDriveCommentGetAction, createDriveCommentListAction, formatDriveCommentListMcp } from "./commentRead.js";

const makeComment = (id: string, resolved: boolean, extra: Partial<DriveComment> = {}): DriveComment => ({
	id, content: `Comment ${id}`, author: { displayName: "Alice", emailAddress: "alice@example.com", me: false },
	createdTime: "2026-11-01T10:00:00Z", modifiedTime: "2026-11-01T10:05:00Z", resolved, ...extra,
});
const makePort = (overrides: Partial<DrivePort> = {}): DrivePort =>
	({ listComments: vi.fn(), getComment: vi.fn(), listReplies: vi.fn(), ...overrides }) as unknown as DrivePort;

describe("drive_comment_list and drive_comment_get (#1645)", () => {
	it("case 1: pages past 100 resolved comments on page 1 to return 3 open comments on page 2", async () => {
		const listComments = vi.fn()
			.mockResolvedValueOnce({ comments: Array.from({ length: 100 }, (_, i) => makeComment(`r-${i}`, true)), nextPageToken: "page-2" })
			.mockResolvedValueOnce({ comments: [makeComment("o-1", false), makeComment("o-2", false), makeComment("o-3", false)] });
		const out = await executeAction(createDriveCommentListAction(makePort({ listComments })), {
			domain: "work", file_id: "sheet-1", limit: 20, include_resolved: false,
		});
		expect([out.comments.map((c) => c.id), out.scanned, out.next_cursor]).toEqual([["o-1", "o-2", "o-3"], 103, null]);
		expect(listComments).toHaveBeenNthCalledWith(2, { domain: "work", fileId: "sheet-1", pageSize: 100, pageToken: "page-2", includeDeleted: false });
	});

	it("case 2: stops after 5 pages of resolved comments with next_cursor and distinguishes empty states", async () => {
		const listComments = vi.fn().mockImplementation(async ({ pageToken }: { pageToken?: string }) => {
			const p = pageToken ? Number(pageToken.split("-")[1]) : 1;
			return { comments: Array.from({ length: 100 }, (_, i) => makeComment(`r-${p}-${i}`, true)), nextPageToken: `page-${p + 1}` };
		});
		const out = await executeAction(createDriveCommentListAction(makePort({ listComments })), { domain: "angus", file_id: "pdf-1" });
		expect([out.comments, out.scanned, out.next_cursor]).toEqual([[], 500, "page-6"]);
		expect(formatDriveCommentListMcp(out)).toMatch(/more comments may exist/i);

		const emptyFile = await executeAction(createDriveCommentListAction(makePort({ listComments: vi.fn().mockResolvedValue({ comments: [] }) })), { domain: "angus", file_id: "empty-1" });
		const filteredOut = await executeAction(createDriveCommentListAction(makePort({ listComments: vi.fn().mockResolvedValue({ comments: [makeComment("r-only", true)] }) })), { domain: "angus", file_id: "res-1" });
		expect(formatDriveCommentListMcp(emptyFile)).toBe("No comments on file empty-1 (angus).");
		expect(formatDriveCommentListMcp(filteredOut)).toMatch(/No comments match the filter/);
	});

	it("case 3: truncates 3000-char content to 2000, quoted_text to 500, and embedded replies to 20", async () => {
		const listComments = vi.fn().mockResolvedValue({
			comments: [makeComment("c-long", false, {
				author: { displayName: "Angus", me: true }, content: "x".repeat(3_000), quotedFileContent: { value: "q".repeat(650) },
				replies: Array.from({ length: 25 }, (_, i) => ({ id: `rep-${i}`, content: `reply ${i}`, author: { displayName: "Bob", me: false } })),
			})],
		});
		const [c] = (await executeAction(createDriveCommentListAction(makePort({ listComments })), { domain: "work", file_id: "slides-1" })).comments;
		expect([c.content.length, c.content_truncated, c.quoted_text?.length, c.author_is_me, c.reply_count, c.replies.length, c.replies_truncated]).toEqual([
			2_000, true, 500, true, 25, 20, true,
		]);
	});

	it("case 4: maps 404 with domain and sharing hint, 403 insufficientPermissions with scope, and scrubs tokens", async () => {
		const missing = createDriveCommentListAction(makePort({ listComments: vi.fn().mockRejectedValue(new DriveApiError("Not found", 404, "notFound")) }));
		await expect(executeAction(missing, { domain: "work", file_id: "missing-f" })).rejects.toMatchObject({
			status: 404, message: expect.stringMatching(/not found in the work account, or not shared with it/),
		});
		const badScope = createDriveCommentGetAction(makePort({ getComment: vi.fn().mockRejectedValue(new DriveApiError("Denied", 403, "insufficientPermissions")) }));
		await expect(executeAction(badScope, { domain: "angus", file_id: "f-1", comment_id: "c-1" })).rejects.toMatchObject({
			status: 403, message: expect.stringContaining("https://www.googleapis.com/auth/drive"),
		});
		const leaked = createDriveCommentListAction(makePort({ listComments: vi.fn().mockRejectedValue(new DriveApiError("Auth failed: Bearer secret-tok-123", 401)) }));
		await expect(executeAction(leaked, { domain: "angus", file_id: "f-1" })).rejects.not.toThrow(/secret-tok-123/);
	});

	it("case 5: pages replies via drive_comment_get and keeps docs_comments working on the shared adapter", async () => {
		const getComment = vi.fn().mockResolvedValue(makeComment("c-7", false));
		const listReplies = vi.fn().mockResolvedValue({ replies: [{ id: "r-1", content: "Ack", author: { displayName: "Angus", me: true } }], nextPageToken: "rep-2" });
		const got = await executeAction(createDriveCommentGetAction(makePort({ getComment, listReplies })), {
			domain: "work", file_id: "sheet-9", comment_id: "c-7", reply_cursor: "rep-1",
		});
		expect([got.comment.id, got.comment.replies.length, got.next_reply_cursor]).toEqual(["c-7", 1, "rep-2"]);
		expect(listReplies).toHaveBeenCalledWith({ domain: "work", fileId: "sheet-9", commentId: "c-7", pageSize: 100, pageToken: "rep-1", includeDeleted: false });

		const adapter = createGoogleDriveAdapter({
			clientId: "cid", clientSecret: "csecret", refreshToken: async () => "rt-angus",
			fetchFn: vi.fn(async (input: string | URL | Request) => new URL(String(input)).href === "https://oauth2.googleapis.com/token"
				? new Response(JSON.stringify({ access_token: "at-angus" }), { status: 200 })
				: new Response(JSON.stringify({ comments: [makeComment("doc-c-1", false), makeComment("doc-c-2", true)] }), { status: 200 })),
		});
		const docsOut = await executeAction(createDocsCommentsAction(adapter), { document_id: "doc-123", domain: "angus", action: "list" });
		expect("comments" in docsOut ? docsOut.comments.map((c) => c.id) : []).toEqual(["doc-c-1"]);
	});
});

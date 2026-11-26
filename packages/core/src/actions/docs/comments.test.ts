import { describe, expect, it, vi } from "vitest";
import type { DrivePort } from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { createDocsCommentsAction, formatDocsCommentsMcp } from "./comments.js";

function makeDrivePort(overrides: Partial<DrivePort> = {}): DrivePort {
	return {
		listComments: vi.fn().mockResolvedValue({ comments: [] }),
		createComment: vi.fn(),
		createReply: vi.fn(),
		...overrides,
	} as unknown as DrivePort;
}

describe("createDocsCommentsAction (#1530)", () => {
	it("lists unresolved comments by default and includes resolved comments when include_resolved is true", async () => {
		const listComments = vi.fn().mockResolvedValue({
			comments: [
				{
					id: "c-1",
					content: "Check section 2",
					author: { displayName: "Alice" },
					createdTime: "2026-10-02T09:00:00Z",
					resolved: false,
					quotedFileContent: { value: " target text " },
					replies: [
						{
							id: "r-1",
							content: "Done",
							author: { emailAddress: "bob@example.com" },
							createdTime: "2026-10-02T09:05:00Z",
						},
					],
				},
				{
					id: "c-2",
					content: "Resolved note",
					author: { displayName: "Carol" },
					createdTime: "2026-10-01T08:00:00Z",
					resolved: true,
				},
			],
		});
		const action = createDocsCommentsAction(makeDrivePort({ listComments }));

		const unresolvedOut = await executeAction(action, {
			document_id: "doc-1",
			domain: "work",
			action: "list",
		});
		expect(listComments).toHaveBeenCalledWith({
			domain: "work",
			fileId: "doc-1",
			pageSize: 100,
			pageToken: undefined,
			includeDeleted: false,
		});
		expect(unresolvedOut).toMatchObject({ domain: "work", file_id: "doc-1", include_resolved: false, scanned: 2, next_cursor: null });
		const unresolvedText = formatDocsCommentsMcp(unresolvedOut);
		expect(unresolvedText).toContain("Comments on work:doc-1 (1 returned, 2 scanned):");
		expect(unresolvedText).toContain('- [c-1] Alice: "Check section 2" (1 reply)');
		expect(unresolvedText).not.toContain("Resolved note");

		const allOut = await executeAction(action, {
			document_id: "doc-1",
			domain: "angus",
			action: "list",
			include_resolved: true,
			page_size: 50,
			cursor: "page-2",
		});
		expect(listComments).toHaveBeenLastCalledWith(expect.objectContaining({ domain: "angus", pageToken: "page-2" }));
		const allText = formatDocsCommentsMcp(allOut);
		expect(allText).toContain("Comments on angus:doc-1 (2 returned, 2 scanned):");
		expect(allText).toContain('- [c-2] Carol (resolved): "Resolved note" (0 replies)');

		const emptyAction = createDocsCommentsAction(makeDrivePort());
		const emptyUnresolved = formatDocsCommentsMcp(
			await executeAction(emptyAction, { document_id: "doc-empty", domain: "angus", action: "list" }),
		);
		expect(emptyUnresolved).toBe("No comments on file doc-empty (angus).");
	});

	it("creates anchored and unanchored comments and replies, and enforces required fields", async () => {
		const createComment = vi.fn().mockResolvedValue({
			id: "c-new",
			content: "Please clarify",
			author: { displayName: "Angus" },
			createdTime: "2026-10-02T10:00:00Z",
		});
		const createReply = vi.fn().mockResolvedValue({
			id: "r-new",
			content: "Clarified",
			author: { displayName: "Angus" },
			createdTime: "2026-10-02T10:05:00Z",
		});
		const action = createDocsCommentsAction(makeDrivePort({ createComment, createReply }));

		const createdOut = await executeAction(action, {
			document_id: "doc-1",
			domain: "angus",
			action: "create",
			content: "Please clarify",
			quoted_text: "ambiguous phrase",
		});
		expect(createComment).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "doc-1",
			content: "Please clarify",
			quotedFileContent: { value: "ambiguous phrase", mimeType: "text/plain" },
		});
		expect(formatDocsCommentsMcp(createdOut)).toContain('Quoted:  "ambiguous phrase"');

		const replyOut = await executeAction(
			action,
			{
				document_id: "doc-1",
				account: "personal",
				action: "reply",
				comment_id: "c-new",
				content: "Clarified",
			} as any,
			{ skipValidation: true },
		);
		expect(createReply).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "doc-1",
			commentId: "c-new",
			content: "Clarified",
		});
		expect(formatDocsCommentsMcp(replyOut)).toContain("Created reply r-new on comment c-new:");

		await expect(
			executeAction(action, { document_id: "doc-1", domain: "angus", action: "create", content: "   " }),
		).rejects.toThrow("content is required when action='create'.");

		await expect(
			executeAction(action, { document_id: "doc-1", domain: "angus", action: "reply", content: "hi" }),
		).rejects.toThrow("comment_id is required when action='reply'. Pass the ID of the comment to reply to.");

		await expect(
			executeAction(action, { document_id: "doc-1", domain: "angus", action: "reply", comment_id: "c-1", content: "" }),
		).rejects.toThrow("content is required when action='reply'.");

		await expect(
			executeAction(action, { document_id: "doc-1", action: "list" } as any, { skipValidation: true }),
		).rejects.toThrow(
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
	});
});

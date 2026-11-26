import { describe, expect, it, vi } from "vitest";
import { createNotionCommentListAction } from "./commentList.js";
import type { NotionPort } from "../../ports/notion.js";

const PAGE_ID = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";
const BLOCK_ID = "11112222-3333-4444-5555-666677778888";

describe("notionCommentListAction", () => {
	it("refuses when domain is missing", async () => {
		const mockPort: NotionPort = {
			resolveToken: vi.fn(),
			search: vi.fn(),
			retrievePage: vi.fn(),
			listBlockChildren: vi.fn(),
			retrieveDatabase: vi.fn(),
			retrieveDataSource: vi.fn(),
			queryDataSource: vi.fn(),
			retrieveBlock: vi.fn(),
			deleteBlock: vi.fn(),
			listComments: vi.fn(),
			createComment: vi.fn(),
		};
		const action = createNotionCommentListAction(mockPort);
		await expect(action.run({} as any, { caller: "test", requestId: "r1" })).rejects.toThrow(
			"`domain` is required to list Notion comments",
		);
	});

	it("refuses when both block_id and page_id are missing", async () => {
		const mockPort: NotionPort = {
			resolveToken: vi.fn(),
			search: vi.fn(),
			retrievePage: vi.fn(),
			listBlockChildren: vi.fn(),
			retrieveDatabase: vi.fn(),
			retrieveDataSource: vi.fn(),
			queryDataSource: vi.fn(),
			retrieveBlock: vi.fn(),
			deleteBlock: vi.fn(),
			listComments: vi.fn(),
			createComment: vi.fn(),
		};
		const action = createNotionCommentListAction(mockPort);
		await expect(
			action.run({ domain: "work" }, { caller: "test", requestId: "r1" }),
		).rejects.toThrow("`block_id` (or `page_id`) is required to list Notion comments");
	});

	it("normalizes id from page_id or block_id and passes pagination params", async () => {
		let capturedParams: any;
		const mockPort: NotionPort = {
			resolveToken: vi.fn(),
			search: vi.fn(),
			retrievePage: vi.fn(),
			listBlockChildren: vi.fn(),
			retrieveDatabase: vi.fn(),
			retrieveDataSource: vi.fn(),
			queryDataSource: vi.fn(),
			retrieveBlock: vi.fn(),
			deleteBlock: vi.fn(),
			listComments: vi.fn(async (params) => {
				capturedParams = params;
				return {
					results: [
						{
							id: "c1",
							discussion_id: "disc_1",
							created_time: "2026-09-25T10:00:00Z",
							created_by: { id: "user_1" },
							rich_text: [{ plain_text: "First comment" }],
						},
						{
							id: "c2",
							created_time: "2026-09-25T10:05:00Z",
							created_by: { id: "user_2" },
							rich_text: [{ text: { content: "Second comment" } }],
						},
					],
					has_more: true,
					next_cursor: "cursor_next",
				};
			}),
			createComment: vi.fn(),
		};

		const action = createNotionCommentListAction(mockPort);
		const result = await action.run(
			{
				domain: "work",
				page_id: PAGE_ID.replace(/-/g, ""),
				limit: 10,
				cursor: "prev_cursor",
			},
			{ caller: "test", requestId: "r1" },
		);

		expect(capturedParams).toEqual({
			workspace: "work",
			blockId: PAGE_ID,
			pageSize: 10,
			cursor: "prev_cursor",
		});

		expect(result.domain).toBe("work");
		expect(result.id).toBe(PAGE_ID);
		expect(result.comments).toHaveLength(2);
		expect(result.hasMore).toBe(true);
		expect(result.nextCursor).toBe("cursor_next");

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain(`Comments on ${PAGE_ID} (work), 2 listed:`);
		expect(formatted).toContain("• [c1] (thread: disc_1) by user_1 at 2026-09-25T10:00:00Z:");
		expect(formatted).toContain("  First comment");
		expect(formatted).toContain("• [c2] by user_2 at 2026-09-25T10:05:00Z:");
		expect(formatted).toContain("  Second comment");
		expect(formatted).toContain("More comments exist. Pass cursor 'cursor_next' to fetch the next page.");
	});

	it("formats empty list correctly", async () => {
		const mockPort: NotionPort = {
			resolveToken: vi.fn(),
			search: vi.fn(),
			retrievePage: vi.fn(),
			listBlockChildren: vi.fn(),
			retrieveDatabase: vi.fn(),
			retrieveDataSource: vi.fn(),
			queryDataSource: vi.fn(),
			retrieveBlock: vi.fn(),
			deleteBlock: vi.fn(),
			listComments: vi.fn(async () => ({
				results: [],
				has_more: false,
				next_cursor: null,
			})),
			createComment: vi.fn(),
		};

		const action = createNotionCommentListAction(mockPort);
		const result = await action.run(
			{ domain: "angus", block_id: BLOCK_ID },
			{ caller: "test", requestId: "r1" },
		);

		expect(result.comments).toHaveLength(0);
		const formatted = action.formatMcp!(result);
		expect(formatted).toBe(`0 comments on ${BLOCK_ID} in the 'angus' workspace.`);
	});

	it("adds cross-workspace hint on 404 status even without (404) in message, and ignores (404) text when status is 500", async () => {
		const notFoundErr = Object.assign(new Error("Notion API error: object_not_found"), {
			name: "NotionApiError" as const,
			status: 404,
		});
		const mockPort404: NotionPort = {
			resolveToken: vi.fn(),
			search: vi.fn(),
			retrievePage: vi.fn(),
			listBlockChildren: vi.fn(),
			retrieveDatabase: vi.fn(),
			retrieveDataSource: vi.fn(),
			queryDataSource: vi.fn(),
			retrieveBlock: vi.fn(),
			deleteBlock: vi.fn(),
			listComments: vi.fn(async () => {
				throw notFoundErr;
			}),
			createComment: vi.fn(),
		};

		const action404 = createNotionCommentListAction(mockPort404);
		await expect(
			action404.run({ domain: "work", block_id: BLOCK_ID }, { caller: "test", requestId: "r1" }),
		).rejects.toThrow("The two workspaces have disjoint page access — if this page lives in the other one, retry with domain='angus'.");

		const serverErr = Object.assign(new Error("Notion API error (404): internal failure"), {
			name: "NotionApiError" as const,
			status: 500,
		});
		const mockPort500: NotionPort = {
			...mockPort404,
			listComments: vi.fn(async () => {
				throw serverErr;
			}),
		};

		const action500 = createNotionCommentListAction(mockPort500);
		await expect(
			action500.run({ domain: "work", block_id: BLOCK_ID }, { caller: "test", requestId: "r2" }),
		).rejects.not.toThrow(/retry with domain/);
	});
});

import { describe, expect, it, vi } from "vitest";
import {
	createNotionCommentCreateAction,
	NOTION_TEXT_LIMIT,
	richTextRuns,
} from "./commentCreate.js";
import type { NotionPort } from "../../ports/notion.js";

const PAGE_ID = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";
const BLOCK_ID = "11112222-3333-4444-5555-666677778888";
const DISC_ID = "99998888-7777-6666-5555-444433332222";

describe("richTextRuns helper", () => {
	it("returns single text run when length <= NOTION_TEXT_LIMIT", () => {
		const runs = richTextRuns("Hello world");
		expect(runs).toEqual([{ type: "text", text: { content: "Hello world" } }]);
	});

	it("splits text into multiple runs when length > NOTION_TEXT_LIMIT", () => {
		const longText = "a".repeat(NOTION_TEXT_LIMIT + 500);
		const runs = richTextRuns(longText);
		expect(runs).toHaveLength(2);
		expect(runs[0].text.content).toHaveLength(NOTION_TEXT_LIMIT);
		expect(runs[1].text.content).toHaveLength(500);
	});
});

describe("notionCommentCreateAction", () => {
	const createMockPort = (overrides?: Partial<NotionPort>): NotionPort => ({
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
		...overrides,
	});

	it("refuses when domain is missing", async () => {
		const action = createNotionCommentCreateAction(createMockPort());
		await expect(action.run({} as any, { caller: "test", requestId: "r1" })).rejects.toThrow(
			"`domain` is required to create a Notion comment",
		);
	});

	it("refuses when no destination is provided", async () => {
		const action = createNotionCommentCreateAction(createMockPort());
		await expect(
			action.run({ domain: "work", text: "hi" } as any, { caller: "test", requestId: "r1" }),
		).rejects.toThrow("Exactly one of `page_id` (new page comment), `block_id` (new block comment), or `discussion_id`");
	});

	it("refuses when multiple destinations are provided", async () => {
		const action = createNotionCommentCreateAction(createMockPort());
		await expect(
			action.run(
				{ domain: "work", page_id: PAGE_ID, block_id: BLOCK_ID, text: "hi" } as any,
				{ caller: "test", requestId: "r1" },
			),
		).rejects.toThrow("Exactly one of `page_id` (new page comment), `block_id` (new block comment), or `discussion_id`");
	});

	it("refuses when comment text is empty", async () => {
		const action = createNotionCommentCreateAction(createMockPort());
		await expect(
			action.run(
				{ domain: "work", page_id: PAGE_ID, text: "   " } as any,
				{ caller: "test", requestId: "r1" },
			),
		).rejects.toThrow("Comment content is required");
	});

	it("creates page comment with normalized id and plain text", async () => {
		let capturedParams: any;
		const mockPort = createMockPort({
			createComment: vi.fn(async (params) => {
				capturedParams = params;
				return {
					id: "comm_123",
					discussion_id: "disc_abc",
					created_time: "2026-10-07T12:00:00.000Z",
				};
			}),
		});

		const action = createNotionCommentCreateAction(mockPort);
		const result = await action.run(
			{
				domain: "work",
				page_id: PAGE_ID.replace(/-/g, ""),
				text: "Great work!",
			},
			{ caller: "test", requestId: "r1" },
		);

		expect(capturedParams).toEqual({
			workspace: "work",
			parent: { page_id: PAGE_ID },
			rich_text: [{ type: "text", text: { content: "Great work!" } }],
		});

		expect(result).toEqual({
			domain: "work",
			id: "comm_123",
			discussionId: "disc_abc",
			createdTime: "2026-10-07T12:00:00.000Z",
		});

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("Created comment comm_123 in the 'work' workspace.");
		expect(formatted).toContain("Discussion thread: disc_abc");
		expect(formatted).toContain("Created at: 2026-10-07T12:00:00.000Z");
	});

	it("creates block comment with raw rich_text array", async () => {
		let capturedParams: any;
		const mockPort = createMockPort({
			createComment: vi.fn(async (params) => {
				capturedParams = params;
				return {
					id: "comm_456",
					discussion_id: "disc_def",
					created_time: "2026-10-07T12:01:00.000Z",
				};
			}),
		});

		const action = createNotionCommentCreateAction(mockPort);
		const customRuns = [{ type: "text", text: { content: "formatted" }, annotations: { bold: true } }];
		const result = await action.run(
			{
				domain: "angus",
				block_id: BLOCK_ID,
				rich_text: customRuns,
			},
			{ caller: "test", requestId: "r1" },
		);

		expect(capturedParams).toEqual({
			workspace: "angus",
			parent: { block_id: BLOCK_ID },
			rich_text: customRuns,
		});
		expect(result.id).toBe("comm_456");
	});

	it("replies to discussion_id", async () => {
		let capturedParams: any;
		const mockPort = createMockPort({
			createComment: vi.fn(async (params) => {
				capturedParams = params;
				return {
					id: "comm_789",
					discussion_id: DISC_ID,
					created_time: "2026-10-07T12:02:00.000Z",
				};
			}),
		});

		const action = createNotionCommentCreateAction(mockPort);
		const result = await action.run(
			{
				domain: "work",
				discussion_id: DISC_ID.replace(/-/g, ""),
				text: "Reply in thread",
			},
			{ caller: "test", requestId: "r1" },
		);

		expect(capturedParams).toEqual({
			workspace: "work",
			discussion_id: DISC_ID,
			rich_text: [{ type: "text", text: { content: "Reply in thread" } }],
		});
		expect(result.id).toBe("comm_789");
	});

	it("adds cross-workspace hint on 404 status even without (404) in message, and ignores (404) text when status is 500", async () => {
		const notFoundErr = Object.assign(new Error("Notion API error: object_not_found"), {
			name: "NotionApiError" as const,
			status: 404,
		});
		const mockPort404 = createMockPort({
			createComment: vi.fn(async () => {
				throw notFoundErr;
			}),
		});

		const action404 = createNotionCommentCreateAction(mockPort404);
		await expect(
			action404.run(
				{ domain: "work", page_id: PAGE_ID, text: "test" },
				{ caller: "test", requestId: "r1" },
			),
		).rejects.toThrow("The two workspaces have disjoint page access — if this page lives in the other one, retry with domain='angus'.");

		const serverErr = Object.assign(new Error("Notion API error (404): internal failure"), {
			name: "NotionApiError" as const,
			status: 500,
		});
		const mockPort500 = createMockPort({
			createComment: vi.fn(async () => {
				throw serverErr;
			}),
		});

		const action500 = createNotionCommentCreateAction(mockPort500);
		await expect(
			action500.run(
				{ domain: "work", page_id: PAGE_ID, text: "test" },
				{ caller: "test", requestId: "r2" },
			),
		).rejects.not.toThrow(/retry with domain/);
	});
});

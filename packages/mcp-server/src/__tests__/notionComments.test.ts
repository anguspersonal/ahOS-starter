import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { notionCommentListHandler } from "../tools/notionCommentList.js";
import { notionCommentCreateHandler } from "../tools/notionCommentCreate.js";
import { listNotionComments, createNotionComment } from "../notion.js";
import { NOTION_TEXT_LIMIT } from "@ahkms/core/actions";

// #1136. Comments row of #830: notion_comment_list and notion_comment_create.

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const WORK_TOKEN = "Bearer secret_test_token";
const ANGUS_TOKEN = "Bearer secret_personal_test_token";
const PAGE_ID = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";
const BLOCK_ID = "11112222-3333-4444-5555-666677778888";
const DISCUSSION_ID = "55556666-7777-8888-9999-000011112222";

type FetchCall = { method: string; url: string; body?: any; auth?: string };

function stubNotion(
	handler?: (call: FetchCall) => { status?: number; ok?: boolean; body: any },
): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			const href = typeof url === "string" ? url : url.toString();
			const method = init.method ?? "GET";
			const call: FetchCall = {
				method,
				url: href,
				body: init.body ? JSON.parse(init.body as string) : undefined,
				auth: (init.headers as Record<string, string> | undefined)?.Authorization,
			};
			calls.push(call);

			if (handler) {
				const res = handler(call);
				const status = res.status ?? (res.ok === false ? 400 : 200);
				const ok = res.ok ?? status < 400;
				return {
					ok,
					status,
					statusText: ok ? "OK" : "Error",
					json: async () => res.body,
					text: async () => JSON.stringify(res.body),
				} as Response;
			}

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ results: [], has_more: false }),
				text: async () => JSON.stringify({ results: [], has_more: false }),
			} as Response;
		}),
	);
	return calls;
}

describe("listNotionComments & createNotionComment (notion.ts client)", () => {
	it("listNotionComments issues GET to /v1/comments with query params", async () => {
		const calls = stubNotion(() => ({
			body: {
				object: "list",
				results: [
					{
						id: "c1",
						discussion_id: "d1",
						created_time: "2026-09-25T10:00:00Z",
						created_by: { id: "user_1" },
						rich_text: [{ plain_text: "A comment" }],
					},
				],
				has_more: true,
				next_cursor: "cur_123",
			},
		}));

		const res = await listNotionComments(PAGE_ID, "test-token", {
			pageSize: 20,
			cursor: "prev_cur",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("GET");
		const parsed = new URL(calls[0].url);
		expect(parsed.pathname).toBe("/v1/comments");
		expect(parsed.searchParams.get("block_id")).toBe(PAGE_ID);
		expect(parsed.searchParams.get("page_size")).toBe("20");
		expect(parsed.searchParams.get("start_cursor")).toBe("prev_cur");
		expect(calls[0].auth).toBe("Bearer test-token");

		expect(res.results).toHaveLength(1);
		expect(res.results[0].id).toBe("c1");
		expect(res.has_more).toBe(true);
		expect(res.next_cursor).toBe("cur_123");
	});

	it("createNotionComment issues POST to /v1/comments with discussion_id", async () => {
		const calls = stubNotion((c) => ({
			body: { id: "c_new", discussion_id: c.body.discussion_id },
		}));

		const res = await createNotionComment("test-token", {
			discussion_id: DISCUSSION_ID,
			rich_text: [{ type: "text", text: { content: "reply" } }],
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(new URL(calls[0].url).pathname).toBe("/v1/comments");
		expect(calls[0].body).toEqual({
			discussion_id: DISCUSSION_ID,
			rich_text: [{ type: "text", text: { content: "reply" } }],
		});
		expect(res.id).toBe("c_new");
	});

	it("createNotionComment throws descriptive error on API failure", async () => {
		stubNotion(() => ({
			status: 400,
			ok: false,
			body: { message: "Invalid parent" },
		}));

		await expect(
			createNotionComment("test-token", {
				parent: { page_id: PAGE_ID },
				rich_text: [],
			}),
		).rejects.toThrow(/Notion create comment failed \(400\)/);
	});
});

describe("notion_comment_list tool", () => {
	it("refuses call when domain is omitted", async () => {
		await expect(
			notionCommentListHandler({ block_id: PAGE_ID } as any),
		).rejects.toThrow(/`domain` is required to list Notion comments/);
	});

	it("refuses call when neither block_id nor page_id is provided", async () => {
		await expect(
			notionCommentListHandler({ domain: "work" }),
		).rejects.toThrow(/`block_id` \(or `page_id`\) is required/);
	});

	it("accepts block_id as URL and resolves domain token", async () => {
		const calls = stubNotion(() => ({
			body: {
				results: [],
				has_more: false,
				next_cursor: null,
			},
		}));

		const res = await notionCommentListHandler({
			domain: "work",
			block_id: `https://notion.so/work/${PAGE_ID.replace(/-/g, "")}`,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].auth).toBe(WORK_TOKEN);
		expect(new URL(calls[0].url).searchParams.get("block_id")).toBe(PAGE_ID);
		expect(res.content[0].text).toContain(`0 comments on ${PAGE_ID} in the 'work' workspace.`);
	});

	it("accepts page_id and authenticates with angus workspace", async () => {
		const calls = stubNotion(() => ({
			body: {
				results: [
					{
						id: "comment_abc",
						discussion_id: DISCUSSION_ID,
						created_time: "2026-09-25T11:00:00.000Z",
						created_by: { id: "user_angus" },
						rich_text: [{ plain_text: "Looks good to merge" }],
					},
				],
				has_more: false,
				next_cursor: null,
			},
		}));

		const res = await notionCommentListHandler({
			domain: "angus",
			page_id: PAGE_ID,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].auth).toBe(ANGUS_TOKEN);
		expect(res.content[0].text).toContain(`Comments on ${PAGE_ID} (angus), 1 listed:`);
		expect(res.content[0].text).toContain(`• [comment_abc] (thread: ${DISCUSSION_ID}) by user_angus`);
		expect(res.content[0].text).toContain("Looks good to merge");
	});

	it("prompts for next_cursor when has_more is true", async () => {
		stubNotion(() => ({
			body: {
				results: [
					{
						id: "c1",
						discussion_id: "d1",
						created_time: "2026-09-25T12:00:00Z",
						created_by: { id: "u1" },
						rich_text: [{ plain_text: "Item 1" }],
					},
				],
				has_more: true,
				next_cursor: "cursor_next_token",
			},
		}));

		const res = await notionCommentListHandler({
			domain: "work",
			block_id: BLOCK_ID,
		});

		expect(res.content[0].text).toContain(
			"More comments exist. Pass cursor 'cursor_next_token' to fetch the next page.",
		);
	});

	it("translates 404 with crossWorkspaceHint", async () => {
		stubNotion(() => ({
			status: 404,
			ok: false,
			body: { code: "object_not_found" },
		}));

		await expect(
			notionCommentListHandler({
				domain: "work",
				block_id: PAGE_ID,
			}),
		).rejects.toThrow(/domain='angus'/);
	});
});

describe("notion_comment_create tool", () => {
	it("refuses call when domain is omitted", async () => {
		await expect(
			notionCommentCreateHandler({ page_id: PAGE_ID, text: "hi" } as any),
		).rejects.toThrow(/`domain` is required to create a Notion comment/);
	});

	it("refuses call when no target or multiple targets provided", async () => {
		await expect(
			notionCommentCreateHandler({ domain: "work", text: "hi" }),
		).rejects.toThrow(/Exactly one of `page_id`/);

		await expect(
			notionCommentCreateHandler({
				domain: "work",
				page_id: PAGE_ID,
				block_id: BLOCK_ID,
				text: "hi",
			}),
		).rejects.toThrow(/Exactly one of `page_id`/);
	});

	it("refuses call when text and rich_text are both missing or empty", async () => {
		await expect(
			notionCommentCreateHandler({
				domain: "work",
				page_id: PAGE_ID,
			}),
		).rejects.toThrow(/Comment content is required/);

		await expect(
			notionCommentCreateHandler({
				domain: "work",
				page_id: PAGE_ID,
				text: "   ",
			}),
		).rejects.toThrow(/Comment content is required/);
	});

	it("creates page comment with parent: { page_id }", async () => {
		const calls = stubNotion((c) => ({
			body: {
				id: "comm_123",
				discussion_id: "disc_456",
				created_time: "2026-09-25T14:00:00.000Z",
			},
		}));

		const res = await notionCommentCreateHandler({
			domain: "work",
			page_id: PAGE_ID,
			text: "Top-level comment on page",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].auth).toBe(WORK_TOKEN);
		expect(calls[0].body).toEqual({
			parent: { page_id: PAGE_ID },
			rich_text: [{ type: "text", text: { content: "Top-level comment on page" } }],
		});
		expect(res.content[0].text).toContain("Created comment comm_123 in the 'work' workspace.");
		expect(res.content[0].text).toContain("Discussion thread: disc_456");
	});

	it("creates block comment with parent: { block_id }", async () => {
		const calls = stubNotion(() => ({
			body: {
				id: "comm_block",
				discussion_id: "disc_block",
				created_time: "2026-09-25T14:00:00.000Z",
			},
		}));

		const res = await notionCommentCreateHandler({
			domain: "angus",
			block_id: BLOCK_ID,
			text: "Comment on block",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].auth).toBe(ANGUS_TOKEN);
		expect(calls[0].body).toEqual({
			parent: { block_id: BLOCK_ID },
			rich_text: [{ type: "text", text: { content: "Comment on block" } }],
		});
		expect(res.content[0].text).toContain("Created comment comm_block in the 'angus' workspace.");
	});

	it("replies to an existing discussion thread via discussion_id", async () => {
		const calls = stubNotion(() => ({
			body: {
				id: "comm_reply",
				discussion_id: DISCUSSION_ID,
				created_time: "2026-09-25T14:00:00.000Z",
			},
		}));

		const res = await notionCommentCreateHandler({
			domain: "work",
			discussion_id: DISCUSSION_ID,
			text: "Thread reply",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].body).toEqual({
			discussion_id: DISCUSSION_ID,
			rich_text: [{ type: "text", text: { content: "Thread reply" } }],
		});
		expect(res.content[0].text).toContain("Created comment comm_reply in the 'work' workspace.");
		expect(res.content[0].text).toContain(`Discussion thread: ${DISCUSSION_ID}`);
	});

	it("splits text exceeding NOTION_TEXT_LIMIT into multiple rich_text runs", async () => {
		const calls = stubNotion(() => ({
			body: { id: "comm_long", discussion_id: "disc_long" },
		}));

		const longText = "a".repeat(NOTION_TEXT_LIMIT + 50);
		await notionCommentCreateHandler({
			domain: "work",
			page_id: PAGE_ID,
			text: longText,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].body.rich_text).toHaveLength(2);
		expect(calls[0].body.rich_text[0].text.content.length).toBe(NOTION_TEXT_LIMIT);
		expect(calls[0].body.rich_text[1].text.content.length).toBe(50);
	});

	it("accepts custom rich_text array directly", async () => {
		const calls = stubNotion(() => ({
			body: { id: "comm_custom", discussion_id: "disc_custom" },
		}));

		const customRuns = [
			{ type: "text", text: { content: "bold part" }, annotations: { bold: true } },
		];
		await notionCommentCreateHandler({
			domain: "work",
			page_id: PAGE_ID,
			rich_text: customRuns,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].body.rich_text).toEqual(customRuns);
	});

	it("translates 404 with crossWorkspaceHint", async () => {
		stubNotion(() => ({
			status: 404,
			ok: false,
			body: { code: "object_not_found" },
		}));

		await expect(
			notionCommentCreateHandler({
				domain: "work",
				page_id: PAGE_ID,
				text: "hello",
			}),
		).rejects.toThrow(/domain='angus'/);
	});
});

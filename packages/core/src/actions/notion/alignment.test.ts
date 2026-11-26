import { describe, expect, it, vi } from "vitest";
import { createNotionSearchAction } from "./search.js";
import { createNotionPageGetAction } from "./pageGet.js";
import { createNotionPageUpdateAction } from "./pageUpdate.js";
import { createNotionPageCreateAction } from "./pageCreate.js";
import { createNotionUserListAction } from "./userList.js";
import { NotionClientAdapter } from "../../adapters/notion/index.js";
import type { NotionBlockItem, NotionPort } from "../../ports/notion.js";

const PAGE_ID = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";
const DB_ID = "11112222-3333-4444-5555-666677778888";
const BLOCK_ID = "b1b1b1b1-0000-0000-0000-000000000001";
const ctx = { caller: "test", requestId: "align-1" };

function makeBlock(index: number): NotionBlockItem {
	const hex = String(index + 1).padStart(12, "0");
	return {
		id: `00000000-0000-0000-0000-${hex}`,
		type: "paragraph",
		paragraph: {
			rich_text: [{ plain_text: `Block ${index + 1}` }],
		},
	};
}

function createFakeNotionPort(allBlocks: NotionBlockItem[] = []): NotionPort {
	const adapter = new NotionClientAdapter(async () => "secret_test_token", {
		clientFactory: () =>
			({
				blocks: {
					children: {
						list: vi.fn(async ({ start_cursor, page_size = 100 }: { start_cursor?: string; page_size?: number }) => {
							const startIdx = start_cursor ? Number.parseInt(start_cursor.replace("cursor_", ""), 10) : 0;
							const slice = allBlocks.slice(startIdx, startIdx + page_size);
							const nextIdx = startIdx + slice.length;
							const hasMore = nextIdx < allBlocks.length;
							return {
								results: slice,
								has_more: hasMore,
								next_cursor: hasMore ? `cursor_${nextIdx}` : null,
							};
						}),
					},
				},
			}) as any,
	});

	return {
		resolveToken: vi.fn(async (w) => `token_${w}`),
		search: vi.fn(async (params) => ({
			results: [
				{
					id: PAGE_ID,
					object: "page",
					url: `https://notion.so/${PAGE_ID.replace(/-/g, "")}`,
					last_edited_time: "2026-10-11T10:00:00.000Z",
					properties: { Name: { type: "title", title: [{ plain_text: "Page" }] } },
				},
			],
			has_more: true,
			next_cursor: params.cursor ? `after_${params.cursor}` : "cursor_page_2",
		})),
		retrievePage: vi.fn(async ({ pageId }) => ({
			id: pageId,
			url: `https://notion.so/${pageId.replace(/-/g, "")}`,
			last_edited_time: "2026-10-11T10:00:00.000Z",
			properties: { Name: { type: "title", title: [{ plain_text: "Test Page" }] } },
		})),
		listBlockChildren: vi.fn((params) => adapter.listBlockChildren(params)),
		retrieveDatabase: vi.fn(async ({ databaseId }) => ({
			id: databaseId,
			properties: {
				Name: { type: "title" },
				Status: { type: "select", select: { options: [{ name: "Amber" }] } },
			},
		})),
		retrieveDataSource: vi.fn(),
		queryDataSource: vi.fn(),
		retrieveBlock: vi.fn(async ({ blockId }) => ({
			id: blockId,
			type: "paragraph",
			parent: { type: "page_id", page_id: PAGE_ID },
		})),
		deleteBlock: vi.fn(),
		listComments: vi.fn(),
		createComment: vi.fn(),
		createPage: vi.fn(async () => ({
			id: PAGE_ID,
			url: `https://notion.so/${PAGE_ID.replace(/-/g, "")}`,
		})),
		appendBlockChildren: vi.fn(async ({ children }) =>
			children.map((_, idx) => `00000000-0000-0000-0000-${String(idx + 1).padStart(12, "0")}`),
		),
		updateBlock: vi.fn(async () => {}),
		updatePage: vi.fn(async () => {}),
		listUsers: vi.fn(async () => [
			{ id: "user-1", name: "Angus", type: "person", email: "owner@example.com" },
		]),
		getStateDocPageId: vi.fn(async () => "ffff0000-0000-0000-0000-000000000000"),
		getDailyLogTargetIds: vi.fn(async () => []),
	};
}

describe("Notion ops comparison alignment (#1656)", () => {
	it("1. notion_search passes cursor to the port and returns its next_cursor", async () => {
		const port = createFakeNotionPort();
		const action = createNotionSearchAction(port);

		const result = await action.run(
			{ domain: "work", query: "Page", cursor: "cursor_page_1" },
			ctx,
		);

		expect(port.search).toHaveBeenCalledWith(
			expect.objectContaining({
				workspace: "work",
				query: "Page",
				cursor: "cursor_page_1",
			}),
		);
		expect(result.hasMore).toBe(true);
		expect(result.next_cursor).toBe("after_cursor_page_1");

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("more matches; pass cursor 'after_cursor_page_1'");
		expect(formatted).not.toContain("raise `limit`");
	});

	it("2. a page with 700 blocks and the default returns 300 blocks, has_more: true, a next_cursor, and the stated cut; passing the cursor returns the next 300", async () => {
		const blocks700 = Array.from({ length: 700 }, (_, i) => makeBlock(i));
		const port = createFakeNotionPort(blocks700);
		const action = createNotionPageGetAction(port);

		const page1 = await action.run({ domain: "work", page_id: PAGE_ID }, ctx);
		expect(page1.blocks).toHaveLength(300);
		expect(page1.blocks[0].id).toBe(blocks700[0].id);
		expect(page1.blocks[299].id).toBe(blocks700[299].id);
		expect(page1.has_more).toBe(true);
		expect(page1.next_cursor).toBe("cursor_300");

		const formatted1 = action.formatMcp!(page1);
		expect(formatted1).toContain("300 blocks shown; more follow, pass cursor 'cursor_300'");

		const page2 = await action.run(
			{ domain: "work", page_id: PAGE_ID, cursor: page1.next_cursor! },
			ctx,
		);
		expect(page2.blocks).toHaveLength(300);
		expect(page2.blocks[0].id).toBe(blocks700[300].id);
		expect(page2.blocks[299].id).toBe(blocks700[599].id);
		expect(page2.has_more).toBe(true);
		expect(page2.next_cursor).toBe("cursor_600");

		const page3 = await action.run(
			{ domain: "work", page_id: PAGE_ID, cursor: page2.next_cursor! },
			ctx,
		);
		expect(page3.blocks).toHaveLength(100);
		expect(page3.blocks[0].id).toBe(blocks700[600].id);
		expect(page3.blocks[99].id).toBe(blocks700[699].id);
		expect(page3.has_more).toBe(false);
		expect(page3.next_cursor).toBeNull();
	});

	it("3. a page of 40 blocks returns all 40 with has_more: false", async () => {
		const blocks40 = Array.from({ length: 40 }, (_, i) => makeBlock(i));
		const port = createFakeNotionPort(blocks40);
		const action = createNotionPageGetAction(port);

		const result = await action.run({ domain: "angus", page_id: PAGE_ID }, ctx);
		expect(result.blocks).toHaveLength(40);
		expect(result.totalBlocks).toBe(40);
		expect(result.has_more).toBe(false);
		expect(result.next_cursor).toBeNull();

		const formatted = action.formatMcp!(result);
		expect(formatted).not.toContain("more follow, pass cursor");
	});

	it("4. migrated notion_page_update, notion_page_create, and notion_user_list receipts carry ids/counts/domain and no property values or text", async () => {
		const port = createFakeNotionPort();
		const updateAction = createNotionPageUpdateAction(port);

		const propReceipt = await updateAction.run(
			{
				domain: "work",
				op: "update_properties",
				page_id: PAGE_ID,
				properties: { Status: { select: { name: "SecretSelectValue" } } },
			},
			ctx,
		);
		expect(propReceipt).toMatchObject({
			domain: "work",
			op: "update_properties",
			page_id: PAGE_ID,
			property_names: ["Status"],
			property_count: 1,
		});
		expect("text" in propReceipt).toBe(false);
		expect("properties" in propReceipt).toBe(false);
		expect(JSON.stringify(propReceipt)).not.toContain("SecretSelectValue");

		const blockReceipt = await updateAction.run(
			{
				domain: "work",
				op: "update_block",
				block_id: BLOCK_ID,
				block_type: "paragraph",
				text: "Confidential block prose",
			},
			ctx,
		);
		expect(blockReceipt).toMatchObject({
			domain: "work",
			op: "update_block",
			block_id: BLOCK_ID,
			block_ids: [BLOCK_ID],
			block_count: 1,
		});
		expect("text" in blockReceipt).toBe(false);
		expect(JSON.stringify(blockReceipt)).not.toContain("Confidential block prose");

		const appendReceipt = await updateAction.run(
			{
				domain: "work",
				op: "append",
				page_id: PAGE_ID,
				body: "- Confidential bullet one\n- Confidential bullet two",
			},
			ctx,
		);
		expect(appendReceipt).toMatchObject({
			domain: "work",
			op: "append",
			page_id: PAGE_ID,
			block_ids: [
				"00000000-0000-0000-0000-000000000001",
				"00000000-0000-0000-0000-000000000002",
			],
			block_count: 2,
		});
		expect("text" in appendReceipt).toBe(false);
		expect(JSON.stringify(appendReceipt)).not.toContain("Confidential bullet");

		const createAction = createNotionPageCreateAction(port);
		const createReceipt = await createAction.run(
			{
				domain: "work",
				database_id: DB_ID,
				title: "Confidential Title",
				properties: { Status: { select: { name: "Amber" } } },
				body: "- body line",
			},
			ctx,
		);
		expect(createReceipt).toMatchObject({
			domain: "work",
			page_id: PAGE_ID,
			block_count: 1,
		});
		expect("text" in createReceipt).toBe(false);
		expect("properties" in createReceipt).toBe(false);
		expect(JSON.stringify(createReceipt)).not.toContain("Amber");
		expect(JSON.stringify(createReceipt)).not.toContain("Confidential Title");

		const userListAction = createNotionUserListAction(port);
		const usersReceipt = await userListAction.run({ domain: "work" }, ctx);
		expect(usersReceipt.domain).toBe("work");
		expect(usersReceipt.count).toBe(1);
	});
});

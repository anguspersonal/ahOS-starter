import { describe, expect, it, vi } from "vitest";
import { createNotionPageUpdateAction } from "./pageUpdate.js";
import type { NotionBlockParent, NotionPort } from "../../ports/notion.js";

const PAGE = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";
const STATE_DOC = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
const BLOCK_1 = "b1b1b1b1-0000-0000-0000-000000000001";
const BLOCK_2 = "b2b2b2b2-0000-0000-0000-000000000002";

const ctx = { caller: "test", requestId: "req-1" };

function notFound(msg: string) {
	return Object.assign(new Error(msg), { name: "NotionApiError" as const, status: 404 });
}

function fakePort(
	stub: {
		stateDocId?: string;
		unwiredStateDoc?: boolean;
		notFound?: boolean;
		blockParents?: Record<string, NotionBlockParent>;
	} = {},
): NotionPort {
	return {
		resolveToken: vi.fn(async (w) => `token_${w}`),
		search: vi.fn(),
		retrievePage: vi.fn(),
		listBlockChildren: vi.fn(),
		retrieveDatabase: vi.fn(),
		retrieveDataSource: vi.fn(),
		queryDataSource: vi.fn(),
		retrieveBlock: vi.fn(async ({ blockId }) => ({
			id: blockId,
			type: "paragraph",
			parent: stub.blockParents?.[blockId],
		})),
		deleteBlock: vi.fn(),
		listComments: vi.fn(),
		createComment: vi.fn(),
		createPage: vi.fn(),
		appendBlockChildren: vi.fn(async () => {
			if (stub.notFound) throw notFound("Notion append block children failed (404): Could not find block");
			return [];
		}),
		updateBlock: vi.fn(async () => {
			if (stub.notFound) throw notFound("Notion update block failed (404): Could not find block");
		}),
		updatePage: vi.fn(async () => {
			if (stub.notFound) throw notFound("Notion update page failed (404): Could not find page");
		}),
		listUsers: vi.fn(),
		...(stub.unwiredStateDoc ? {} : { getStateDocPageId: vi.fn(async () => stub.stateDocId) }),
	};
}

describe("notion_page_update", () => {
	it("requires domain and op, each error naming the accepted values", async () => {
		const action = createNotionPageUpdateAction(fakePort());
		await expect(action.run({ op: "append", page_id: PAGE }, ctx)).rejects.toThrow(
			/'work'.*'angus'|'angus'.*'work'/,
		);
		await expect(action.run({ domain: "angus", page_id: PAGE }, ctx)).rejects.toThrow(
			/'append'.*'update_block'.*'update_properties'/,
		);
	});

	it("rejects arguments that mean nothing for the operation", async () => {
		const action = createNotionPageUpdateAction(fakePort());
		await expect(
			action.run({ domain: "angus", op: "append", page_id: PAGE, text: "x" }, ctx),
		).rejects.toThrow(/does not accept \[text\]/);
	});

	it("append converts body lines to blocks (headings allowed) and passes workspace to port", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		const out = await action.run(
			{
				domain: "angus",
				op: "append",
				page_id: PAGE,
				body: "## Update\n- [x] booked Rankins\nplain line",
			},
			ctx,
		);

		expect(port.appendBlockChildren).toHaveBeenCalledTimes(1);
		const call = vi.mocked(port.appendBlockChildren).mock.calls[0][0];
		expect(call.workspace).toBe("angus");
		expect(call.blockId).toBe(PAGE);
		expect(call.children).toHaveLength(3);
		expect(JSON.stringify(call.children[0])).toContain("heading_2");
		expect(JSON.stringify(call.children[1])).toContain('"checked":true');
		expect(action.formatMcp!(out)).toBe(`Appended 3 block(s) to ${PAGE} (domain='angus').`);
	});

	it("append passes `after` through as a positioned insert", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		const out = await action.run(
			{
				domain: "angus",
				op: "append",
				page_id: PAGE,
				after: BLOCK_1,
				body: "- new line",
			},
			ctx,
		);

		const call = vi.mocked(port.appendBlockChildren).mock.calls[0][0];
		expect(call.after).toBe(BLOCK_1);
		expect(action.formatMcp!(out)).toBe(
			`Appended 1 block(s) to ${PAGE} (domain='angus') after the given sibling.`,
		);
	});

	it("update_block sends a type-keyed patch with the new text (and checked for to_do)", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		const out = await action.run(
			{
				domain: "work",
				op: "update_block",
				block_id: BLOCK_2,
				block_type: "to_do",
				text: "Passport renewed",
				checked: true,
			},
			ctx,
		);

		expect(port.updateBlock).toHaveBeenCalledTimes(1);
		const call = vi.mocked(port.updateBlock).mock.calls[0][0];
		expect(call.workspace).toBe("work");
		expect(call.blockId).toBe(BLOCK_2);
		expect(call.payload).toEqual({
			to_do: {
				rich_text: [{ type: "text", text: { content: "Passport renewed" } }],
				checked: true,
			},
		});
		expect(action.formatMcp!(out)).toBe(`Updated block ${BLOCK_2} (to_do, domain='work').`);
	});

	it("append and update_block parse inline Markdown links and annotations into Notion rich_text runs (#1946)", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		await action.run(
			{
				domain: "angus",
				op: "append",
				page_id: PAGE,
				body: "- See [the doc](https://example.com/doc) for **important** details",
			},
			ctx,
		);

		const appendCall = vi.mocked(port.appendBlockChildren).mock.calls[0][0];
		expect((appendCall.children[0] as any).bulleted_list_item.rich_text).toEqual([
			{ type: "text", text: { content: "See " } },
			{
				type: "text",
				text: { content: "the doc", link: { url: "https://example.com/doc" } },
			},
			{ type: "text", text: { content: " for " } },
			{
				type: "text",
				text: { content: "important" },
				annotations: { bold: true },
			},
			{ type: "text", text: { content: " details" } },
		]);

		await action.run(
			{
				domain: "angus",
				op: "update_block",
				block_id: BLOCK_2,
				block_type: "paragraph",
				text: "Updated with [a link](https://example.com) and `code`",
			},
			ctx,
		);

		const blockCall = vi.mocked(port.updateBlock).mock.calls[0][0];
		expect(blockCall.payload).toEqual({
			paragraph: {
				rich_text: [
					{ type: "text", text: { content: "Updated with " } },
					{
						type: "text",
						text: { content: "a link", link: { url: "https://example.com" } },
					},
					{ type: "text", text: { content: " and " } },
					{
						type: "text",
						text: { content: "code" },
						annotations: { code: true },
					},
				],
			},
		});
	});

	it("update_properties passes raw Notion value shapes through untouched", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		const out = await action.run(
			{
				domain: "angus",
				op: "update_properties",
				page_id: PAGE,
				properties: { Status: { select: { name: "Amber" } } },
			},
			ctx,
		);

		const call = vi.mocked(port.updatePage).mock.calls[0][0];
		expect(call.workspace).toBe("angus");
		expect(call.pageId).toBe(PAGE);
		expect(call.properties).toEqual({ Status: { select: { name: "Amber" } } });
		expect(action.formatMcp!(out)).toBe(
			`Page ${PAGE} (domain='angus'): updated 1 property (Status).`,
		);
	});

	it("refuses the domain's State Doc page on each op before any Notion write (ADR-053 one-writer rule)", async () => {
		const port = fakePort({
			// Undashed on purpose: the guard must match whatever shape the config holds.
			stateDocId: STATE_DOC.replace(/-/g, ""),
			blockParents: {
				[BLOCK_2]: { type: "page_id", page_id: STATE_DOC },
			},
		});
		const action = createNotionPageUpdateAction(port);

		await expect(
			action.run(
				{
					domain: "angus",
					op: "append",
					page_id: STATE_DOC,
					body: "- sneak a section in",
				},
				ctx,
			),
		).rejects.toThrow(/state_doc_update/);

		await expect(
			action.run(
				{
					domain: "angus",
					op: "update_block",
					block_id: STATE_DOC,
					block_type: "paragraph",
					text: "sneak an edit in",
				},
				ctx,
			),
		).rejects.toThrow(/state_doc_update/);

		await expect(
			action.run(
				{
					domain: "angus",
					op: "update_block",
					block_id: BLOCK_2,
					block_type: "paragraph",
					text: "sneak a nested block edit in",
				},
				ctx,
			),
		).rejects.toThrow(/state_doc_update/);

		await expect(
			action.run(
				{
					domain: "angus",
					op: "update_properties",
					page_id: STATE_DOC,
					properties: { Status: { select: { name: "Green" } } },
				},
				ctx,
			),
		).rejects.toThrow(/state_doc_update/);

		expect(port.appendBlockChildren).not.toHaveBeenCalled();
		expect(port.updateBlock).not.toHaveBeenCalled();
		expect(port.updatePage).not.toHaveBeenCalled();
	});

	it("refuses every op when getStateDocPageId is unwired on the port", async () => {
		const port = fakePort({ unwiredStateDoc: true });
		const action = createNotionPageUpdateAction(port);

		await expect(
			action.run({ domain: "angus", op: "append", page_id: PAGE, body: "- x" }, ctx),
		).rejects.toThrow(/getStateDocPageId.*is not wired/);

		await expect(
			action.run(
				{ domain: "angus", op: "update_block", block_id: BLOCK_2, block_type: "paragraph", text: "x" },
				ctx,
			),
		).rejects.toThrow(/getStateDocPageId.*is not wired/);

		await expect(
			action.run(
				{ domain: "angus", op: "update_properties", page_id: PAGE, archived: true },
				ctx,
			),
		).rejects.toThrow(/getStateDocPageId.*is not wired/);

		expect(port.appendBlockChildren).not.toHaveBeenCalled();
		expect(port.updateBlock).not.toHaveBeenCalled();
		expect(port.updatePage).not.toHaveBeenCalled();
	});

	it("a 404 on write carries the cross-workspace hint", async () => {
		const port = fakePort({ notFound: true });
		const action = createNotionPageUpdateAction(port);

		await expect(
			action.run(
				{
					domain: "work",
					op: "append",
					page_id: PAGE,
					body: "- x",
				},
				ctx,
			),
		).rejects.toThrow(/retry with domain='angus'/);
	});
});

describe("notion_page_update — archive and restore (#1058)", () => {
	it("archived: true then false round-trips with dev's text, touching nothing else", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		const trashed = await action.run(
			{
				domain: "work",
				op: "update_properties",
				page_id: PAGE,
				archived: true,
			},
			ctx,
		);

		expect(vi.mocked(port.updatePage).mock.calls[0][0]).toEqual({
			workspace: "work",
			pageId: PAGE,
			archived: true,
		});
		expect(action.formatMcp!(trashed)).toBe(
			`Page ${PAGE} (domain='work'): moved it to Notion's trash (restore with archived:false).`,
		);

		const restored = await action.run(
			{
				domain: "work",
				op: "update_properties",
				page_id: PAGE,
				archived: false,
			},
			ctx,
		);

		expect(vi.mocked(port.updatePage).mock.calls[1][0]).toEqual({
			workspace: "work",
			pageId: PAGE,
			archived: false,
		});
		expect(action.formatMcp!(restored)).toBe(
			`Page ${PAGE} (domain='work'): restored it from Notion's trash.`,
		);
	});

	it("patches properties and archives in ONE request", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		const out = await action.run(
			{
				domain: "work",
				op: "update_properties",
				page_id: PAGE,
				properties: { Status: { select: { name: "Dropped" } } },
				archived: true,
			},
			ctx,
		);

		expect(port.updatePage).toHaveBeenCalledTimes(1);
		expect(vi.mocked(port.updatePage).mock.calls[0][0]).toEqual({
			workspace: "work",
			pageId: PAGE,
			properties: { Status: { select: { name: "Dropped" } } },
			archived: true,
		});
		expect(action.formatMcp!(out)).toBe(
			`Page ${PAGE} (domain='work'): updated 1 property (Status); moved it to Notion's trash (restore with archived:false).`,
		);
	});

	it("sets an icon", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		const out = await action.run(
			{
				domain: "work",
				op: "update_properties",
				page_id: PAGE,
				icon: { emoji: "📓" },
			},
			ctx,
		);

		expect(vi.mocked(port.updatePage).mock.calls[0][0]).toEqual({
			workspace: "work",
			pageId: PAGE,
			icon: { emoji: "📓" },
		});
		expect(action.formatMcp!(out)).toBe(`Page ${PAGE} (domain='work'): set the icon.`);
	});

	it("refuses a call that supplies none of properties, archived or icon", async () => {
		const port = fakePort();
		const action = createNotionPageUpdateAction(port);

		await expect(
			action.run({ domain: "work", op: "update_properties", page_id: PAGE }, ctx),
		).rejects.toThrow(/at least one of/i);

		expect(port.updatePage).not.toHaveBeenCalled();
	});

	it("still refuses to archive the State Doc (ADR-053)", async () => {
		const port = fakePort({ stateDocId: STATE_DOC.replace(/-/g, "") });
		const action = createNotionPageUpdateAction(port);

		await expect(
			action.run(
				{
					domain: "angus",
					op: "update_properties",
					page_id: STATE_DOC,
					archived: true,
				},
				ctx,
			),
		).rejects.toThrow(/State Doc/);

		expect(port.updatePage).not.toHaveBeenCalled();
	});
});

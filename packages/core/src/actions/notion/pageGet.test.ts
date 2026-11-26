import { describe, expect, it, vi } from "vitest";
import { blockPlainText, createNotionPageGetAction } from "./pageGet.js";
import { NOTION_TEXT_LIMIT, richTextRuns } from "./blocks.js";
import type {
	NotionBlockChildrenResponse,
	NotionPageResponse,
	NotionPort,
} from "../../ports/notion.js";

const PAGE_ID = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";

function createMockPort(options?: {
	page?: NotionPageResponse;
	blocks?: NotionBlockChildrenResponse;
	retrieveError?: Error;
	listBlocksError?: Error;
}): NotionPort {
	return {
		resolveToken: vi.fn(async (workspace: string) => `secret_token_${workspace}`),
		search: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		retrievePage: vi.fn(async () => {
			if (options?.retrieveError) throw options.retrieveError;
			return (
				options?.page ?? {
					id: PAGE_ID,
					url: `https://notion.so/${PAGE_ID.replace(/-/g, "")}`,
					last_edited_time: "2026-09-02T10:00:00.000Z",
					properties: {
						Name: { type: "title", title: [{ plain_text: "Test Page" }] },
					},
				}
			);
		}),
		listBlockChildren: vi.fn(async () => {
			if (options?.listBlocksError) throw options.listBlocksError;
			return (
				options?.blocks ?? {
					results: [
						{
							id: "b1b1b1b1-0000-0000-0000-000000000001",
							type: "heading_2",
							heading_2: { rich_text: [{ plain_text: "RAG" }] },
							has_children: true,
						},
					],
					has_more: false,
					next_cursor: null,
				}
			);
		}),
	};
}

describe("notionPageGetAction", () => {
	it("requires domain, naming both workspaces when omitted", async () => {
		const port = createMockPort();
		const action = createNotionPageGetAction(port);

		await expect(
			action.run({ page_id: PAGE_ID } as any, { caller: "test", requestId: "1" }),
		).rejects.toThrow(/'work'.*'angus'|'angus'.*'work'/);
		expect(port.resolveToken).not.toHaveBeenCalled();
		expect(port.listBlockChildren).not.toHaveBeenCalled();
		expect(port.retrievePage).not.toHaveBeenCalled();
	});

	it("requires page_id", async () => {
		const port = createMockPort();
		const action = createNotionPageGetAction(port);

		await expect(
			action.run({ domain: "work" } as any, { caller: "test", requestId: "2" }),
		).rejects.toThrow(/`page_id` is required/);
	});

	it("normalizes page_id from URL, resolves token, and returns typed result", async () => {
		const port = createMockPort();
		const action = createNotionPageGetAction(port);

		const url = `https://www.notion.so/myworkspace/My-Page-Title-${PAGE_ID.replace(/-/g, "")}`;
		const result = await action.run(
			{ domain: "work", page_id: url },
			{ caller: "test", requestId: "3" },
		);

		expect(port.resolveToken).toHaveBeenCalledWith("work");
		expect(port.listBlockChildren).toHaveBeenCalledWith({
			workspace: "work",
			blockId: PAGE_ID,
			maxBlocks: 300,
		});
		expect(port.retrievePage).toHaveBeenCalledWith({
			workspace: "work",
			pageId: PAGE_ID,
		});

		// Typed result verification (not MCP envelope)
		expect(result).toEqual({
			id: PAGE_ID,
			domain: "work",
			hasPageEnvelope: true,
			page: expect.objectContaining({ id: PAGE_ID }),
			blocks: [
				expect.objectContaining({
					id: "b1b1b1b1-0000-0000-0000-000000000001",
					type: "heading_2",
				}),
			],
			totalBlocks: 1,
			has_more: false,
			next_cursor: null,
		});

		// formatMcp renders expected text output
		const formatted = action.formatMcp!(result);
		expect(formatted).toContain(`Notion read: ${PAGE_ID} (domain='work')`);
		expect(formatted).toContain("Blocks (1):");
		expect(formatted).toContain("heading_2");
		expect(formatted).toContain("RAG");
	});

	it("tolerates missing page envelope when retrievePage 404s (e.g. block or database container)", async () => {
		const notFoundErr = Object.assign(new Error("Notion API error: object_not_found"), {
			name: "NotionApiError" as const,
			status: 404,
		});
		const port = createMockPort({
			retrieveError: notFoundErr,
		});
		const action = createNotionPageGetAction(port);

		const result = await action.run(
			{ domain: "work", page_id: PAGE_ID },
			{ caller: "test", requestId: "4" },
		);

		expect(result.hasPageEnvelope).toBe(false);
		expect(result.page).toBeUndefined();
		expect(result.blocks).toHaveLength(1);

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("block or database container");
		expect(formatted).toContain("Blocks (1):");
	});

	it("re-throws 404 status from listBlockChildren with cross-workspace retry hint even without (404) in message, and ignores (404) text when status is 500", async () => {
		const notFoundErr = Object.assign(new Error("Notion API error: object_not_found"), {
			name: "NotionApiError" as const,
			status: 404,
		});
		const port404 = createMockPort({
			listBlocksError: notFoundErr,
		});
		const action404 = createNotionPageGetAction(port404);

		await expect(
			action404.run({ domain: "angus", page_id: PAGE_ID }, { caller: "test", requestId: "5" }),
		).rejects.toThrow(/retry with domain='work'/);

		const serverErr = Object.assign(new Error("Notion API error (404): internal failure"), {
			name: "NotionApiError" as const,
			status: 500,
		});
		const port500 = createMockPort({
			listBlocksError: serverErr,
		});
		const action500 = createNotionPageGetAction(port500);

		await expect(
			action500.run({ domain: "angus", page_id: PAGE_ID }, { caller: "test", requestId: "6" }),
		).rejects.not.toThrow(/retry with domain/);
	});

	it("renders inline links and annotations in blockPlainText and formatMcp output", () => {
		const blockWithRichText = {
			id: "b3b3b3b3-0000-0000-0000-000000000003",
			type: "paragraph",
			paragraph: {
				rich_text: [
					{ plain_text: "Track in " },
					{
						plain_text: "Linear",
						text: { content: "Linear", link: { url: "https://linear.app/work/issue/1" } },
						annotations: { bold: true },
					},
					{ plain_text: " or " },
					{
						plain_text: "GitHub",
						href: "https://github.com/anguspersonal/ahOS/issues/1946",
					},
					{ plain_text: " with " },
					{ plain_text: "italic", annotations: { italic: true } },
					{ plain_text: ", " },
					{ plain_text: "code", annotations: { code: true } },
					{ plain_text: ", and " },
					{ plain_text: "struck", annotations: { strikethrough: true } },
				],
			},
		};

		expect(blockPlainText(blockWithRichText as any)).toBe(
			"Track in [**Linear**](https://linear.app/work/issue/1) or [GitHub](https://github.com/anguspersonal/ahOS/issues/1946) with *italic*, `code`, and ~~struck~~",
		);
	});

	it("preserves links whose display text equals the URL on blockPlainText -> richTextRuns round-trips", () => {
		const selfLinkedBlock = {
			id: "b4b4b4b4-0000-0000-0000-000000000004",
			type: "paragraph",
			paragraph: {
				rich_text: [
					{ plain_text: "Visit " },
					{
						plain_text: "https://example.com/docs",
						text: { content: "https://example.com/docs", link: { url: "https://example.com/docs" } },
					},
					{ plain_text: " now" },
				],
			},
		};

		const serialized = blockPlainText(selfLinkedBlock as any);
		expect(serialized).toBe("Visit [https://example.com/docs](https://example.com/docs) now");
		expect(richTextRuns(serialized)).toEqual([
			{ type: "text", text: { content: "Visit " } },
			{
				type: "text",
				text: {
					content: "https://example.com/docs",
					link: { url: "https://example.com/docs" },
				},
			},
			{ type: "text", text: { content: " now" } },
		]);
	});

	it("coalesces >2000-char chunked runs and round-trips through richTextRuns -> blockPlainText -> richTextRuns", () => {
		const longText = "a".repeat(NOTION_TEXT_LIMIT + 350);
		for (const markdown of [
			`**${longText}**`,
			`*${longText}*`,
			`\`${longText}\``,
			`[${longText}](https://example.com/long)`,
			`[**${longText}**](https://example.com/long)`,
		]) {
			const initialRuns = richTextRuns(markdown);
			expect(initialRuns).toHaveLength(2);

			const serialized = blockPlainText({
				id: "b5b5b5b5-0000-0000-0000-000000000005",
				type: "paragraph",
				paragraph: { rich_text: initialRuns },
			} as any);

			expect(serialized).toBe(markdown);
			expect(richTextRuns(serialized)).toEqual(initialRuns);
		}
	});

	it("hoists leading/trailing whitespace outside emphasis delimiters and supports combined code + emphasis annotations", () => {
		const whitespaceBlock = {
			id: "b6b6b6b6-0000-0000-0000-000000000006",
			type: "paragraph",
			paragraph: {
				rich_text: [
					{ plain_text: "Hello ", annotations: { italic: true } },
					{ plain_text: "world" },
					{ plain_text: "   ", annotations: { bold: true } },
					{ plain_text: "done", annotations: { bold: true, code: true } },
					{ plain_text: " and " },
					{
						plain_text: "flag",
						annotations: { bold: true, italic: true, strikethrough: true, code: true },
					},
				],
			},
		};

		const serialized = blockPlainText(whitespaceBlock as any);
		expect(serialized).toBe("*Hello* world   **`done`** and ***~~`flag`~~***");
		expect(richTextRuns(serialized)).toEqual([
			{ type: "text", text: { content: "Hello" }, annotations: { italic: true } },
			{ type: "text", text: { content: " world   " } },
			{ type: "text", text: { content: "done" }, annotations: { bold: true, code: true } },
			{ type: "text", text: { content: " and " } },
			{
				type: "text",
				text: { content: "flag" },
				annotations: { bold: true, italic: true, strikethrough: true, code: true },
			},
		]);
	});
});

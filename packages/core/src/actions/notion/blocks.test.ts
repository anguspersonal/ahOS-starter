import { describe, expect, it } from "vitest";
import { NOTION_TEXT_LIMIT, markdownToBlocks, richTextRuns } from "./blocks.js";

describe("markdownToBlocks", () => {
	it("maps each line marker to its Notion block type, skipping blank lines", () => {
		const blocks = markdownToBlocks(
			[
				"# Top",
				"## Section",
				"",
				"a paragraph",
				"- a bullet",
				"* also a bullet",
				"- [ ] an open to-do",
				"- [x] a done to-do",
				"1. numbered",
				"> quoted",
			].join("\n"),
		);

		expect(blocks.map((b) => b.type)).toEqual([
			"heading_1",
			"heading_2",
			"paragraph",
			"bulleted_list_item",
			"bulleted_list_item",
			"to_do",
			"to_do",
			"numbered_list_item",
			"quote",
		]);
		expect((blocks[5] as any).to_do.checked).toBe(false);
		expect((blocks[6] as any).to_do.checked).toBe(true);
	});

	it("clamps a heading deeper than Notion has to heading_3", () => {
		const [block] = markdownToBlocks("###### deep");
		expect(block.type).toBe("heading_3");
		expect((block as any).heading_3.rich_text[0].text.content).toBe("deep");
	});

	it("splits one long line across rich-text runs rather than exceeding Notion's cap", () => {
		// The whole reason the Daily Log body cannot go through createNotionTask's `body`:
		// that path emits ONE run holding the entire body, and a day's synthesis routinely
		// runs past 2000 characters, so the first real write would 400.
		const [block] = markdownToBlocks("y".repeat(NOTION_TEXT_LIMIT * 2 + 7));
		const runs = (block as any).paragraph.rich_text;
		expect(runs).toHaveLength(3);
		expect(runs.every((r: any) => r.text.content.length <= NOTION_TEXT_LIMIT)).toBe(true);
		expect(runs.map((r: any) => r.text.content).join("")).toHaveLength(NOTION_TEXT_LIMIT * 2 + 7);
	});

	it("keeps a short line as exactly one run, unchanged from the pre-split shape", () => {
		const [block] = markdownToBlocks("short");
		expect((block as any).paragraph.rich_text).toEqual([
			{ type: "text", text: { content: "short" } },
		]);
	});

	it("lets the caller decide what a heading means", () => {
		expect(() =>
			markdownToBlocks("## nope", {
				onHeading(line) {
					throw new Error(`rejected: ${line}`);
				},
			}),
		).toThrow(/rejected: ## nope/);
	});

	it("parses inline Markdown links and annotations inside blocks", () => {
		const [block] = markdownToBlocks(
			"- [x] Review [PR #1946](https://github.com/anguspersonal/ahOS/pull/1946) with **urgent** notes",
		);
		expect(block.type).toBe("to_do");
		expect((block as any).to_do.rich_text).toEqual([
			{ type: "text", text: { content: "Review " } },
			{
				type: "text",
				text: {
					content: "PR #1946",
					link: { url: "https://github.com/anguspersonal/ahOS/pull/1946" },
				},
			},
			{ type: "text", text: { content: " with " } },
			{
				type: "text",
				text: { content: "urgent" },
				annotations: { bold: true },
			},
			{ type: "text", text: { content: " notes" } },
		]);
	});
});

describe("richTextRuns inline Markdown parser", () => {
	it("parses [label](url) links and preserves surrounding plain text", () => {
		expect(
			richTextRuns(
				"See [the spec](https://example.com/spec) and [email us](mailto:team@example.com).",
			),
		).toEqual([
			{ type: "text", text: { content: "See " } },
			{
				type: "text",
				text: { content: "the spec", link: { url: "https://example.com/spec" } },
			},
			{ type: "text", text: { content: " and " } },
			{
				type: "text",
				text: { content: "email us", link: { url: "mailto:team@example.com" } },
			},
			{ type: "text", text: { content: "." } },
		]);
	});

	it("handles balanced parentheses inside link URLs", () => {
		expect(
			richTextRuns("Read [Rust (language)](https://en.wikipedia.org/wiki/Rust_(programming_language))"),
		).toEqual([
			{ type: "text", text: { content: "Read " } },
			{
				type: "text",
				text: {
					content: "Rust (language)",
					link: { url: "https://en.wikipedia.org/wiki/Rust_(programming_language)" },
				},
			},
		]);
	});

	it("leaves unmatched brackets and non-URL targets as literal text", () => {
		expect(richTextRuns("[todo] check [relative](/path/only) and [unclosed")).toEqual([
			{
				type: "text",
				text: { content: "[todo] check [relative](/path/only) and [unclosed" },
			},
		]);
	});

	it("parses **bold**, *italic*, _italic_, `code`, and ~~strikethrough~~", () => {
		expect(
			richTextRuns("**bold** and *italic* and _also italic_ and `inline_code` and ~~struck~~"),
		).toEqual([
			{ type: "text", text: { content: "bold" }, annotations: { bold: true } },
			{ type: "text", text: { content: " and " } },
			{ type: "text", text: { content: "italic" }, annotations: { italic: true } },
			{ type: "text", text: { content: " and " } },
			{ type: "text", text: { content: "also italic" }, annotations: { italic: true } },
			{ type: "text", text: { content: " and " } },
			{ type: "text", text: { content: "inline_code" }, annotations: { code: true } },
			{ type: "text", text: { content: " and " } },
			{ type: "text", text: { content: "struck" }, annotations: { strikethrough: true } },
		]);
	});

	it("does not treat snake_case identifiers as _italic_ or parse inside `code` spans", () => {
		expect(richTextRuns("Keep state_doc_update and `[not_a_link](https://example.com) **raw**`")).toEqual([
			{ type: "text", text: { content: "Keep state_doc_update and " } },
			{
				type: "text",
				text: { content: "[not_a_link](https://example.com) **raw**" },
				annotations: { code: true },
			},
		]);
	});

	it("supports nested formatting with links ([**bold link**](url), **[bold link](url)**, ***bold italic***)", () => {
		expect(
			richTextRuns(
				"[**Linear #1**](https://linear.app/issue/1) and **[Linear #2](https://linear.app/issue/2)** and ***both***",
			),
		).toEqual([
			{
				type: "text",
				text: { content: "Linear #1", link: { url: "https://linear.app/issue/1" } },
				annotations: { bold: true },
			},
			{ type: "text", text: { content: " and " } },
			{
				type: "text",
				text: { content: "Linear #2", link: { url: "https://linear.app/issue/2" } },
				annotations: { bold: true },
			},
			{ type: "text", text: { content: " and " } },
			{
				type: "text",
				text: { content: "both" },
				annotations: { bold: true, italic: true },
			},
		]);
	});

	it("chunks runs longer than NOTION_TEXT_LIMIT while preserving link and annotations", () => {
		const longLabel = "x".repeat(NOTION_TEXT_LIMIT + 250);
		const runs = richTextRuns(`[**${longLabel}**](https://example.com/long)`);
		expect(runs).toHaveLength(2);
		expect(runs[0]).toEqual({
			type: "text",
			text: {
				content: "x".repeat(NOTION_TEXT_LIMIT),
				link: { url: "https://example.com/long" },
			},
			annotations: { bold: true },
		});
		expect(runs[1]).toEqual({
			type: "text",
			text: {
				content: "x".repeat(250),
				link: { url: "https://example.com/long" },
			},
			annotations: { bold: true },
		});
	});

	it("parses adjacent bold/italic spans (**bold***italic*, *italic***bold**, **a****b**) without corrupting delimiters", () => {
		expect(richTextRuns("**bold***italic*")).toEqual([
			{ type: "text", text: { content: "bold" }, annotations: { bold: true } },
			{ type: "text", text: { content: "italic" }, annotations: { italic: true } },
		]);

		expect(richTextRuns("*italic***bold**")).toEqual([
			{ type: "text", text: { content: "italic" }, annotations: { italic: true } },
			{ type: "text", text: { content: "bold" }, annotations: { bold: true } },
		]);

		expect(richTextRuns("**a****b**")).toEqual([
			{ type: "text", text: { content: "ab" }, annotations: { bold: true } },
		]);
	});

	it("preserves nested emphasis inside bold or italic (**bold *inner italic*** and *italic **inner bold***)", () => {
		expect(richTextRuns("**bold *inner italic***")).toEqual([
			{ type: "text", text: { content: "bold " }, annotations: { bold: true } },
			{
				type: "text",
				text: { content: "inner italic" },
				annotations: { bold: true, italic: true },
			},
		]);

		expect(richTextRuns("*italic **inner bold***")).toEqual([
			{ type: "text", text: { content: "italic " }, annotations: { italic: true } },
			{
				type: "text",
				text: { content: "inner bold" },
				annotations: { italic: true, bold: true },
			},
		]);
	});
});

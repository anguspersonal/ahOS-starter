import { describe, expect, it } from "vitest";
import type { NotionBlock, NotionRichTextRun } from "../ports/notion.js";
import {
	blockPlainText,
	buildHeadingBlock,
	buildLastUpdatedText,
	findLastUpdatedBlock,
	findSectionSpan,
	headerRegion,
	parseSectionBody,
	rewriteLastUpdatedLine,
	sectionBodyBlocks,
	sectionHeadings,
} from "./stateDoc.js";

let counter = 0;
function id(prefix: string): string {
	counter += 1;
	return `${prefix}-${counter}`;
}

function runs(...parts: [string, Record<string, unknown>?][]): NotionRichTextRun[] {
	return parts.map(([content, annotations]) => ({
		type: "text",
		text: { content },
		plain_text: content,
		...(annotations ? { annotations } : {}),
	}));
}

function block(
	type: string,
	richText: NotionRichTextRun[],
	extra: Record<string, unknown> = {},
): NotionBlock {
	return { id: id(type), type, [type]: { rich_text: richText, ...extra } };
}

function heading(level: 1 | 2 | 3, text: string): NotionBlock {
	return block(`heading_${level}`, runs([text]));
}

function para(text: string): NotionBlock {
	return block("paragraph", runs([text]));
}

function bullet(text: string): NotionBlock {
	return block("bulleted_list_item", runs([text]));
}

export const CALLOUT_RUNS: NotionRichTextRun[] = runs(
	["📌 ", { bold: false }],
	["Last updated:", { bold: true }],
	[" 2026-07-27 (dos-hl)\n"],
	["Sole writer:", { bold: true }],
	[" dos-hl ritual\n"],
	["Read by:", { bold: true }],
	[" every operating-partner session"],
);

export function stateDocFixture(): NotionBlock[] {
	counter = 0;
	return [
		{ id: id("callout"), type: "callout", callout: { rich_text: CALLOUT_RUNS, icon: { emoji: "📌" } } },
		para("If something here conflicts with the most recent Daily Log entry, this State Doc wins."),

		heading(2, "🏢 Company snapshot"),
		para("Seed-stage, 4 people, London."),
		bullet("Runway: 14 months"),

		// The stray `#`, second among the headings, with every heading after it at `##`.
		heading(1, "🎯 This week focus — Week 27 Jul – 2 Aug 2026"),
		bullet("Ship the 4.8 resubmission"),
		bullet("Close the Bri intro loop"),

		heading(2, "📌 Open Actions"),
		bullet("Chase Mitesh for PR fix ETA"),
		bullet("Test SIWA on device"),

		heading(2, "📣 Recent communications log"),
		bullet("27 Jul: chased Mitesh on PR ETA"),

		heading(2, "🚧 Known blockers"),
		bullet("Apple review 4.8 gate"),

		heading(2, "🧱 Tech stack"),
		para("Next.js, Supabase, Railway."),

		heading(2, "⚖️ Legal / Compliance"),
		para("DPA with the pilot customer signed 12 Jun."),
	];
}

describe("section addressing", () => {
	it("lists every heading regardless of level", () => {
		expect(sectionHeadings(stateDocFixture())).toEqual([
			"🏢 Company snapshot",
			"🎯 This week focus — Week 27 Jul – 2 Aug 2026",
			"📌 Open Actions",
			"📣 Recent communications log",
			"🚧 Known blockers",
			"🧱 Tech stack",
			"⚖️ Legal / Compliance",
		]);
	});

	it("errors on a heading that does not exist, naming the headings that do", () => {
		expect(() => findSectionSpan(stateDocFixture(), "Open Actions")).toThrow(
			/No section headed "Open Actions"/,
		);
		expect(() => findSectionSpan(stateDocFixture(), "Open Actions")).toThrow(/📌 Open Actions/);
	});

	it("errors on an ambiguous heading rather than picking one", () => {
		const blocks = stateDocFixture();
		const duplicate = { ...blocks[8], id: "dupe" };
		expect(() => findSectionSpan([...blocks, duplicate], "📌 Open Actions")).toThrow(
			/matches 2 headings/,
		);
	});

	it("ends a section at the next heading of ANY level, not the next same-or-higher one", () => {
		const blocks = stateDocFixture();
		// The stray `#`: under the same-or-higher rule its span would run to the end of
		// the page, because no second `#` follows it.
		const span = findSectionSpan(blocks, "🎯 This week focus — Week 27 Jul – 2 Aug 2026");
		const body = sectionBodyBlocks(blocks, span);

		expect(body).toHaveLength(2);
		expect(body.map(blockPlainText)).toEqual([
			"Ship the 4.8 resubmission",
			"Close the Bri intro loop",
		]);
		expect(blockPlainText(blocks[span.end])).toBe("📌 Open Actions");
	});

	it("runs the last section to the end of the page", () => {
		const blocks = stateDocFixture();
		const span = findSectionSpan(blocks, "⚖️ Legal / Compliance");
		expect(span.end).toBe(blocks.length);
		expect(sectionBodyBlocks(blocks, span)).toHaveLength(1);
	});
});

describe("parseSectionBody", () => {
	it("maps one line to one block, recognising bullets, to-dos, numbers and quotes", () => {
		const blocks = parseSectionBody(
			["Plain prose.", "- a bullet", "* another bullet", "- [x] done thing", "- [ ] open thing", "1. first", "> quoted", "", "  "].join("\n"),
		);

		expect(blocks.map((b) => b.type)).toEqual([
			"paragraph",
			"bulleted_list_item",
			"bulleted_list_item",
			"to_do",
			"to_do",
			"numbered_list_item",
			"quote",
		]);
		expect((blocks[3].to_do as { checked: boolean }).checked).toBe(true);
		expect((blocks[4].to_do as { checked: boolean }).checked).toBe(false);
		expect((blocks[1].bulleted_list_item as { rich_text: { text: { content: string } }[] }).rich_text[0].text.content).toBe(
			"a bullet",
		);
	});

	it("parses inline markdown links and annotations into Notion rich_text runs (#1946)", () => {
		const [block] = parseSectionBody("**bold** and [a link](https://example.com)");
		const richText = (block.paragraph as { rich_text: unknown[] }).rich_text;
		expect(richText).toEqual([
			{ type: "text", text: { content: "bold" }, annotations: { bold: true } },
			{ type: "text", text: { content: " and " } },
			{
				type: "text",
				text: { content: "a link", link: { url: "https://example.com" } },
			},
		]);
	});

	it("rejects a heading inside a body, which would move the section boundary", () => {
		expect(() => parseSectionBody("intro\n## Sneaky subsection")).toThrow(/flat span/);
	});
});

describe("buildHeadingBlock", () => {
	it("defaults to heading_2, the page's dominant level", () => {
		expect(buildHeadingBlock("New section").type).toBe("heading_2");
		expect(buildHeadingBlock("New section", 1).type).toBe("heading_1");
	});
});

describe("the Last updated stamp", () => {
	it("finds the header callout and ignores anything after the first heading", () => {
		const blocks = stateDocFixture();
		expect(findLastUpdatedBlock(headerRegion(blocks))?.type).toBe("callout");
		expect(headerRegion(blocks)).toHaveLength(2);
	});

	it("rewrites only the Last updated line, leaving Sole writer and Read by byte-identical", () => {
		const text = buildLastUpdatedText("replace", ["📌 Open Actions"], new Date("2026-08-10T09:00:00Z"));
		const rewritten = rewriteLastUpdatedLine(CALLOUT_RUNS, text);
		expect(rewritten).not.toBeNull();

		const before = CALLOUT_RUNS.map((r) => r.plain_text ?? "").join("");
		const after = rewritten!.map((r) => r.text.content).join("");

		expect(after.split("\n")[0]).toBe(
			'📌 Last updated: 2026-08-10 (state_doc_update: replace "📌 Open Actions")',
		);
		// Every other line survives character for character.
		expect(after.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
		expect(after).toContain("Sole writer: dos-hl ritual");
		expect(after).toContain("Read by: every operating-partner session");
	});

	it("keeps the bold annotations on the untouched governance labels", () => {
		const rewritten = rewriteLastUpdatedLine(CALLOUT_RUNS, "Last updated: 2026-08-10")!;
		const bolded = rewritten
			.filter((r) => (r.annotations as { bold?: boolean } | undefined)?.bold)
			.map((r) => r.text.content);
		expect(bolded).toContain("Sole writer:");
		expect(bolded).toContain("Read by:");
	});

	it("returns null when the block carries no Last updated line", () => {
		expect(
			rewriteLastUpdatedLine([{ type: "text", text: { content: "Sole writer: x" }, plain_text: "Sole writer: x" }], "Last updated: x"),
		).toBeNull();
	});

	it("names the sections it touched", () => {
		expect(buildLastUpdatedText("delete", ["🧱 Tech stack"], new Date("2026-08-10T23:59:00Z"))).toBe(
			'Last updated: 2026-08-10 (state_doc_update: delete "🧱 Tech stack")',
		);
	});
});

import type { NotionBlock, NotionRichTextRun } from "../ports/notion.js";
import { markdownToBlocks, type BlockPayload } from "../ports/notion.js";

// Section mechanics for the Notion State Doc (ADR-053).
//
// Pure functions over an ordered array of Notion blocks: no I/O, no config, no
// token. tools/updateStateDoc.ts does the fetching and writing; everything that
// decides *what* to write lives here, so it can be tested against a fixture of the
// real page shape instead of against Notion.
//
// Two rules from ADR-053 are load-bearing and deliberately not "improved" on:
//
//  1. A section is addressed by EXACT heading text. Zero matches or more than one
//     is an error, never a guess — a silent wrong-section replace on this page
//     destroys prose that exists nowhere else, and the page is read at the start of
//     every session.
//  2. A section is a FLAT SPAN: from its heading block to the next heading block of
//     ANY level. The conventional same-or-higher rule would be destructive here —
//     the page carries exactly one `#` among fifteen `##`s, so replacing that one
//     section would swallow the entire rest of the document.

/** Notion's heading block types. A section boundary is any of these, regardless of level. */
export const HEADING_BLOCK_TYPES = ["heading_1", "heading_2", "heading_3"] as const;

// The block/heading payload types moved to notionBlocks.ts with the line parser
// (#674). Re-exported here because the State Doc's own callers import them from
// this module and the split is an internal one.
export type { BlockPayload, HeadingLevel } from "../ports/notion.js";

/** Rich-text run as sent to Notion. Read-only fields (`plain_text`, `href`) are dropped. */
export type RichTextPayload = {
	type: "text";
	text: { content: string; link?: { url: string } | null };
	annotations?: Record<string, unknown>;
};

export function isHeadingBlock(block: NotionBlock): boolean {
	return (HEADING_BLOCK_TYPES as readonly string[]).includes(block.type);
}

/** The rich-text runs of a block, whatever its type. Empty for blocks that carry none. */
export function blockRichText(block: NotionBlock): NotionRichTextRun[] {
	const payload = block[block.type] as { rich_text?: NotionRichTextRun[] } | undefined;
	return payload?.rich_text ?? [];
}

function runText(run: NotionRichTextRun): string {
	return run.plain_text ?? run.text?.content ?? "";
}

/** A block's text with formatting flattened — what a heading match compares against. */
export function blockPlainText(block: NotionBlock): string {
	return blockRichText(block).map(runText).join("");
}

/** Every heading on the page, in order. Used to make a no-match error actionable. */
export function sectionHeadings(blocks: NotionBlock[]): string[] {
	return blocks.filter(isHeadingBlock).map((b) => blockPlainText(b).trim());
}

/**
 * A section's extent. `headingIndex` is the heading block; `end` is exclusive and is
 * the index of the next heading of any level, or the end of the page. Body blocks are
 * `blocks.slice(headingIndex + 1, end)`.
 */
export type SectionSpan = {
	heading: string;
	headingIndex: number;
	end: number;
};

/** Indexes of every heading block whose (trimmed) text equals `heading` exactly. */
export function findHeadingIndexes(blocks: NotionBlock[], heading: string): number[] {
	const wanted = heading.trim();
	const hits: number[] = [];
	blocks.forEach((block, i) => {
		if (isHeadingBlock(block) && blockPlainText(block).trim() === wanted) hits.push(i);
	});
	return hits;
}

/**
 * Resolve a section by exact heading text, or throw. Zero matches and multiple
 * matches are BOTH errors: the caller has just read the page, so it knows the heading
 * verbatim, and guessing here is the failure mode this tool exists to remove.
 */
export function findSectionSpan(blocks: NotionBlock[], heading: string): SectionSpan {
	const hits = findHeadingIndexes(blocks, heading);
	const available = sectionHeadings(blocks)
		.map((h) => `"${h}"`)
		.join(", ");

	if (hits.length === 0) {
		throw new Error(
			`No section headed "${heading}" on the State Doc. Sections are addressed by exact heading text (ADR-053), so copy it verbatim from the page you just read. Headings on the page: ${available || "(none)"}.`,
		);
	}
	if (hits.length > 1) {
		throw new Error(
			`"${heading}" matches ${hits.length} headings on the State Doc. Ambiguity is an error, never a guess (ADR-053) — nothing was written. Make the headings distinct before writing through this tool.`,
		);
	}

	const headingIndex = hits[0];
	let end = blocks.length;
	for (let i = headingIndex + 1; i < blocks.length; i++) {
		if (isHeadingBlock(blocks[i])) {
			end = i;
			break;
		}
	}

	return { heading: heading.trim(), headingIndex, end };
}

/** The body blocks of a resolved section (everything between the heading and the next one). */
export function sectionBodyBlocks(blocks: NotionBlock[], span: SectionSpan): NotionBlock[] {
	return blocks.slice(span.headingIndex + 1, span.end);
}

// --- Body → blocks -----------------------------------------------------------

/**
 * Turn a section body into Notion blocks, one block per non-blank line.
 *
 * The line parsing is markdownToBlocks (notionBlocks.ts), shared with the Daily Log
 * writer. The one State-Doc-specific rule stays here: a heading line inside a body is
 * rejected, because a section is a flat span from its heading to the next heading of
 * any level, so a heading in the middle of one would silently redefine where the
 * section ends.
 */
export function parseSectionBody(body: string): BlockPayload[] {
	return markdownToBlocks(body, {
		onHeading(line) {
			throw new Error(
				`Section body contains a heading line (${line.trim()}). A section is a flat span from its heading to the next heading of any level (ADR-053), so a heading inside a body would move the section boundary. Use op:'insert' to add a section instead.`,
			);
		},
	});
}

/** A heading block payload at the given level (default `heading_2`, the page's norm). */
export { buildHeadingBlock } from "../ports/notion.js";

// --- The `Last updated` stamp ------------------------------------------------

const LAST_UPDATED = /\blast updated\b/i;

/**
 * The header region: every block before the first heading. The `Last updated` stamp
 * lives in the page's header callout, and confining the search there means a stray
 * "last updated" inside a section's prose can never be rewritten by mistake.
 */
export function headerRegion(blocks: NotionBlock[]): NotionBlock[] {
	const firstHeading = blocks.findIndex(isHeadingBlock);
	return firstHeading === -1 ? blocks : blocks.slice(0, firstHeading);
}

/** The header block carrying a `Last updated` line, if the page has one. */
export function findLastUpdatedBlock(blocks: NotionBlock[]): NotionBlock | undefined {
	return blocks.find((block) =>
		blockPlainText(block)
			.split("\n")
			.some((line) => LAST_UPDATED.test(line)),
	);
}

/** The stamp text, naming the operation and the sections it touched. */
export function buildLastUpdatedText(
	op: string,
	headings: string[],
	now: Date = new Date(),
): string {
	const date = now.toISOString().slice(0, 10);
	const named = headings.map((h) => `"${h}"`).join(", ");
	return `Last updated: ${date} (state_doc_update: ${op}${named ? ` ${named}` : ""})`;
}

function sliceRun(run: NotionRichTextRun, from: number, to: number): RichTextPayload | null {
	const content = runText(run).slice(from, to);
	if (!content) return null;
	const payload: RichTextPayload = { type: "text", text: { content } };
	if (run.text?.link) payload.text.link = run.text.link;
	if (run.annotations) payload.annotations = run.annotations;
	return payload;
}

/**
 * Rewrite ONLY the `Last updated` line of a block's rich text, returning the full new
 * run list — or null when the block has no such line.
 *
 * Every other line survives character-for-character with its own annotations and
 * links, because runs outside the replaced span are sliced rather than rebuilt. That
 * is the constraint from ADR-053 § 4: `Sole writer` and `Read by` sit in the same
 * callout and are human-authored governance, not derived, so the tool must not touch
 * them. Text before the match on the stamp line (an emoji, a bold label) is kept too.
 */
export function rewriteLastUpdatedLine(
	runs: NotionRichTextRun[],
	newText: string,
): RichTextPayload[] | null {
	const full = runs.map(runText).join("");

	let replaceFrom = -1;
	let replaceTo = -1;
	let lineStart = 0;
	for (;;) {
		const newline = full.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? full.length : newline;
		const offset = full.slice(lineStart, lineEnd).search(LAST_UPDATED);
		if (offset !== -1) {
			replaceFrom = lineStart + offset;
			replaceTo = lineEnd;
			break;
		}
		if (newline === -1) break;
		lineStart = newline + 1;
	}

	if (replaceFrom === -1) return null;

	const head: RichTextPayload[] = [];
	const tail: RichTextPayload[] = [];
	let annotationsAtCut: Record<string, unknown> | undefined;
	let offset = 0;

	for (const run of runs) {
		const length = runText(run).length;
		const start = offset;
		const end = offset + length;
		offset = end;
		if (length === 0) continue;

		if (start < replaceFrom) {
			const piece = sliceRun(run, 0, Math.min(length, replaceFrom - start));
			if (piece) head.push(piece);
		}
		if (start <= replaceFrom && replaceFrom < end) annotationsAtCut = run.annotations;
		if (end > replaceTo) {
			const piece = sliceRun(run, Math.max(0, replaceTo - start), length);
			if (piece) tail.push(piece);
		}
	}

	const stamp: RichTextPayload = {
		type: "text",
		text: { content: newText },
		...(annotationsAtCut ? { annotations: annotationsAtCut } : {}),
	};

	return [...head, stamp, ...tail];
}

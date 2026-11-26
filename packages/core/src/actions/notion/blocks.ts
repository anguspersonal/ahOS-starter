// Markdown-ish body -> Notion block payloads. No I/O, no config, no token.
//
// Extracted from stateDoc.ts by #674 so the Daily Log writer and the State Doc's
// section writer share ONE line parser. They differ in exactly one rule - a heading
// line is a hard error inside a State Doc section body (it would move the section
// boundary, ADR-053) but is ordinary content in a Daily Log entry, whose body is five
// `##` sections - so heading handling is the caller's callback rather than a flag.

/** Block payload as sent to Notion (`{ object, type, [type]: {...} }`). */
export type BlockPayload = Record<string, unknown>;

/** Notion's heading block levels. Deeper markdown headings clamp to 3. */
export type HeadingLevel = 1 | 2 | 3;

/** Inline formatting flags supported on a Notion rich-text run. */
export type NotionInlineAnnotations = {
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	code?: boolean;
};

/** One Notion rich-text run produced by `richTextRuns`. */
export type RichTextRun = {
	type: "text";
	text: {
		content: string;
		link?: { url: string };
	};
	annotations?: NotionInlineAnnotations;
};

/**
 * Notion's hard cap on a single rich-text run's `text.content`. A block may carry many
 * runs, so a long line is split across runs rather than truncated or dropped - the
 * previous Daily Log write path put a whole day's synthesis into ONE run and would have
 * 400'd on the first real body.
 */
export const NOTION_TEXT_LIMIT = 2000;

const MARKDOWN_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const TODO = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const VALID_LINK_URL = /^(?:https?:\/\/|mailto:)\S+$/;

type InlineSegment = {
	content: string;
	link?: string;
	annotations: NotionInlineAnnotations;
};

type LinkMatch = {
	label: string;
	url: string;
	endIndex: number;
};

function matchMarkdownLink(input: string, startIndex: number): LinkMatch | null {
	if (input[startIndex] !== "[") return null;

	let closeBracket = -1;
	for (let i = startIndex + 1; i < input.length; i++) {
		const ch = input[i];
		if (ch === "[" || ch === "\n") {
			return null;
		}
		if (ch === "]") {
			closeBracket = i;
			break;
		}
	}

	if (closeBracket <= startIndex + 1) return null;
	if (input[closeBracket + 1] !== "(") return null;

	let parenDepth = 0;
	let closeParen = -1;
	for (let i = closeBracket + 2; i < input.length; i++) {
		const ch = input[i];
		if (/\s/.test(ch)) {
			return null;
		}
		if (ch === "(") {
			parenDepth += 1;
		} else if (ch === ")") {
			if (parenDepth > 0) {
				parenDepth -= 1;
			} else {
				closeParen = i;
				break;
			}
		}
	}

	if (closeParen === -1) return null;

	const url = input.slice(closeBracket + 2, closeParen);
	if (!VALID_LINK_URL.test(url)) return null;

	return {
		label: input.slice(startIndex + 1, closeBracket),
		url,
		endIndex: closeParen + 1,
	};
}

function skipCodeOrLink(input: string, index: number, allowLinks: boolean): number | null {
	if (input[index] === "`") {
		const closeTick = input.indexOf("`", index + 1);
		if (closeTick > index + 1) return closeTick;
	}
	if (allowLinks && input[index] === "[") {
		const link = matchMarkdownLink(input, index);
		if (link) return link.endIndex - 1;
	}
	return null;
}

function findClosingTripleAsterisk(input: string, fromIndex: number, allowLinks: boolean): number {
	for (let j = fromIndex; j <= input.length - 3; j++) {
		const skipped = skipCodeOrLink(input, j, allowLinks);
		if (skipped !== null) {
			j = skipped;
			continue;
		}
		if (input.startsWith("***", j)) {
			return j;
		}
	}
	return -1;
}

function findClosingDoubleAsterisk(input: string, fromIndex: number, allowLinks: boolean): number {
	let hasOpenSingle = false;
	for (let j = fromIndex; j <= input.length - 2; j++) {
		const skipped = skipCodeOrLink(input, j, allowLinks);
		if (skipped !== null) {
			j = skipped;
			continue;
		}
		if (input.startsWith("***", j)) {
			if (hasOpenSingle && input[j - 1] !== " ") {
				return j + 1;
			}
			return j;
		}
		if (input.startsWith("**", j)) {
			return j;
		}
		if (input[j] === "*") {
			if (!hasOpenSingle && input[j + 1] !== undefined && input[j + 1] !== " ") {
				hasOpenSingle = true;
			} else if (hasOpenSingle && input[j - 1] !== " ") {
				hasOpenSingle = false;
			}
		}
	}
	return -1;
}

function findClosingDoubleTilde(input: string, fromIndex: number, allowLinks: boolean): number {
	for (let j = fromIndex; j <= input.length - 2; j++) {
		const skipped = skipCodeOrLink(input, j, allowLinks);
		if (skipped !== null) {
			j = skipped;
			continue;
		}
		if (input.startsWith("~~", j)) {
			return j;
		}
	}
	return -1;
}

function findClosingSingleAsterisk(input: string, fromIndex: number, allowLinks: boolean): number {
	let hasOpenDouble = false;
	for (let j = fromIndex; j < input.length; j++) {
		const skipped = skipCodeOrLink(input, j, allowLinks);
		if (skipped !== null) {
			j = skipped;
			continue;
		}
		if (input.startsWith("***", j)) {
			if (hasOpenDouble) {
				if (input[j - 1] !== " ") {
					return j + 2;
				}
				hasOpenDouble = false;
				j += 2;
				continue;
			}
			if (input[j - 1] !== " ") {
				return j;
			}
			j += 2;
			continue;
		}
		if (input.startsWith("**", j)) {
			if (hasOpenDouble) {
				hasOpenDouble = false;
				j += 1;
				continue;
			}
			if (input[j + 2] !== undefined && input[j + 2] !== "*") {
				const closeDouble = findClosingDoubleAsterisk(input, j + 2, allowLinks);
				if (closeDouble > j + 2) {
					hasOpenDouble = true;
					j += 1;
					continue;
				}
			}
			if (input[j - 1] !== " ") {
				return j;
			}
			j += 1;
			continue;
		}
		if (input[j] === "*" && !hasOpenDouble && input[j - 1] !== " ") {
			return j;
		}
	}
	return -1;
}

function findClosingUnderscore(input: string, fromIndex: number, allowLinks: boolean): number {
	for (let j = fromIndex; j < input.length; j++) {
		const skipped = skipCodeOrLink(input, j, allowLinks);
		if (skipped !== null) {
			j = skipped;
			continue;
		}
		if (
			input[j] === "_" &&
			!/[\s_]/.test(input[j - 1]) &&
			(j + 1 === input.length || /[\s)\]}"'*~.,;:!?]/.test(input[j + 1]))
		) {
			return j;
		}
	}
	return -1;
}

function parseInlineTokens(
	input: string,
	annotations: NotionInlineAnnotations = {},
	link?: string,
): InlineSegment[] {
	const segments: InlineSegment[] = [];
	let plain = "";
	const allowLinks = link === undefined;

	const flushPlain = () => {
		if (plain.length > 0) {
			segments.push({
				content: plain,
				...(link ? { link } : {}),
				annotations: { ...annotations },
			});
			plain = "";
		}
	};

	let i = 0;
	while (i < input.length) {
		// 1. Inline code: `code` (no inner markdown parsing)
		if (input[i] === "`" && input[i + 1] !== "`") {
			const closeTick = input.indexOf("`", i + 1);
			if (closeTick > i + 1) {
				flushPlain();
				segments.push({
					content: input.slice(i + 1, closeTick),
					...(link ? { link } : {}),
					annotations: { ...annotations, code: true },
				});
				i = closeTick + 1;
				continue;
			}
		}

		// 2. Inline link: [label](url)
		if (allowLinks && input[i] === "[") {
			const matchedLink = matchMarkdownLink(input, i);
			if (matchedLink) {
				flushPlain();
				segments.push(
					...parseInlineTokens(matchedLink.label, annotations, matchedLink.url),
				);
				i = matchedLink.endIndex;
				continue;
			}
		}

		// 3. Bold + italic: ***text***
		if (input.startsWith("***", i) && input[i + 3] !== undefined && input[i + 3] !== "*") {
			const closeTriple = findClosingTripleAsterisk(input, i + 3, allowLinks);
			if (closeTriple > i + 3) {
				flushPlain();
				segments.push(
					...parseInlineTokens(
						input.slice(i + 3, closeTriple),
						{ ...annotations, bold: true, italic: true },
						link,
					),
				);
				i = closeTriple + 3;
				continue;
			}
		}

		// 4. Bold: **text**
		if (input.startsWith("**", i) && input[i + 2] !== undefined && input[i + 2] !== "*") {
			const closeDouble = findClosingDoubleAsterisk(input, i + 2, allowLinks);
			if (closeDouble > i + 2) {
				flushPlain();
				segments.push(
					...parseInlineTokens(
						input.slice(i + 2, closeDouble),
						{ ...annotations, bold: true },
						link,
					),
				);
				i = closeDouble + 2;
				continue;
			}
		}

		// 5. Strikethrough: ~~text~~
		if (input.startsWith("~~", i) && input[i + 2] !== undefined && input[i + 2] !== "~") {
			const closeTilde = findClosingDoubleTilde(input, i + 2, allowLinks);
			if (closeTilde > i + 2) {
				flushPlain();
				segments.push(
					...parseInlineTokens(
						input.slice(i + 2, closeTilde),
						{ ...annotations, strikethrough: true },
						link,
					),
				);
				i = closeTilde + 2;
				continue;
			}
		}

		// 6. Italic: *text*
		if (
			input[i] === "*" &&
			input[i + 1] !== undefined &&
			input[i + 1] !== "*" &&
			input[i + 1] !== " "
		) {
			const closeSingle = findClosingSingleAsterisk(input, i + 1, allowLinks);
			if (closeSingle > i + 1) {
				flushPlain();
				segments.push(
					...parseInlineTokens(
						input.slice(i + 1, closeSingle),
						{ ...annotations, italic: true },
						link,
					),
				);
				i = closeSingle + 1;
				continue;
			}
		}

		// 7. Italic: _text_ (word-boundary aware so snake_case and URLs stay untouched)
		if (
			input[i] === "_" &&
			(i === 0 || /[\s([{"'*~>]/.test(input[i - 1])) &&
			input[i + 1] !== undefined &&
			!/[\s_]/.test(input[i + 1])
		) {
			const closeUnderscore = findClosingUnderscore(input, i + 1, allowLinks);
			if (closeUnderscore > i + 1) {
				flushPlain();
				segments.push(
					...parseInlineTokens(
						input.slice(i + 1, closeUnderscore),
						{ ...annotations, italic: true },
						link,
					),
				);
				i = closeUnderscore + 1;
				continue;
			}
		}

		plain += input[i];
		i += 1;
	}

	flushPlain();
	return segments;
}

function sameAnnotations(a: NotionInlineAnnotations, b: NotionInlineAnnotations): boolean {
	return (
		Boolean(a.bold) === Boolean(b.bold) &&
		Boolean(a.italic) === Boolean(b.italic) &&
		Boolean(a.strikethrough) === Boolean(b.strikethrough) &&
		Boolean(a.code) === Boolean(b.code)
	);
}

function buildNormalizedAnnotations(
	annotations: NotionInlineAnnotations,
): NotionInlineAnnotations | undefined {
	const out: NotionInlineAnnotations = {};
	if (annotations.bold) out.bold = true;
	if (annotations.italic) out.italic = true;
	if (annotations.strikethrough) out.strikethrough = true;
	if (annotations.code) out.code = true;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse inline Markdown (`[label](url)`, `**bold**`, `*italic*` / `_italic_`,
 * `` `code` ``, `~~strikethrough~~`) and split runs no longer than Notion accepts.
 */
export function richTextRuns(content: string): RichTextRun[] {
	if (content.length === 0) {
		return [{ type: "text", text: { content: "" } }];
	}

	const rawSegments = parseInlineTokens(content);
	const merged: InlineSegment[] = [];
	for (const seg of rawSegments) {
		if (seg.content.length === 0) continue;
		const prev = merged[merged.length - 1];
		if (prev && prev.link === seg.link && sameAnnotations(prev.annotations, seg.annotations)) {
			prev.content += seg.content;
		} else {
			merged.push({
				content: seg.content,
				...(seg.link ? { link: seg.link } : {}),
				annotations: { ...seg.annotations },
			});
		}
	}

	if (merged.length === 0) {
		return [{ type: "text", text: { content: "" } }];
	}

	const runs: RichTextRun[] = [];
	for (const seg of merged) {
		const annotations = buildNormalizedAnnotations(seg.annotations);
		for (let i = 0; i < seg.content.length; i += NOTION_TEXT_LIMIT) {
			const chunk = seg.content.slice(i, i + NOTION_TEXT_LIMIT);
			const run: RichTextRun = {
				type: "text",
				text: {
					content: chunk,
					...(seg.link ? { link: { url: seg.link } } : {}),
				},
				...(annotations ? { annotations } : {}),
			};
			runs.push(run);
		}
	}
	return runs;
}

/** A text-bearing block of the given Notion type. */
export function textBlock(
	type: string,
	content: string,
	extra: Record<string, unknown> = {},
): BlockPayload {
	return {
		object: "block",
		type,
		[type]: {
			rich_text: richTextRuns(content),
			...extra,
		},
	};
}

/** A heading block payload at the given level (default `heading_2`, the State Doc's norm). */
export function buildHeadingBlock(
	text: string,
	level: HeadingLevel = 2,
	annotations?: Record<string, unknown>,
): BlockPayload {
	const type = `heading_${level}`;
	const runs = richTextRuns(text).map((run) => {
		if (!annotations && !run.annotations) return run;
		return {
			...run,
			annotations: {
				...(annotations ?? {}),
				...(run.annotations ?? {}),
			},
		};
	});
	return {
		object: "block",
		type,
		[type]: {
			rich_text: runs,
		},
	};
}

/**
 * Turn a body into Notion blocks, one block per non-blank line.
 *
 * Recognises list markers, to-do checkboxes, numbered lists, quotes, and headings,
 * and parses inline markdown (`[label](url)`, `**bold**`, `*italic*` / `_italic_`,
 * `` `code` ``, `~~strikethrough~~`) into Notion `rich_text` runs.
 *
 * `onHeading` decides what a `#`-prefixed line means. Omitted, it becomes a Notion
 * heading block (levels beyond 3 clamp to `heading_3`, which is all Notion has). The
 * State Doc's section writer passes one that throws instead.
 */
export function markdownToBlocks(
	body: string,
	opts: { onHeading?: (line: string, level: HeadingLevel, text: string) => BlockPayload } = {},
): BlockPayload[] {
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	const blocks: BlockPayload[] = [];

	for (const raw of lines) {
		const line = raw.trimEnd();
		if (!line.trim()) continue;

		const heading = MARKDOWN_HEADING.exec(line);
		if (heading) {
			const level = Math.min(heading[1].length, 3) as HeadingLevel;
			const text = heading[2].trim();
			blocks.push(
				opts.onHeading
					? opts.onHeading(line, level, text)
					: buildHeadingBlock(text, level),
			);
			continue;
		}

		const todo = TODO.exec(line);
		if (todo) {
			blocks.push(textBlock("to_do", todo[2], { checked: todo[1].toLowerCase() === "x" }));
			continue;
		}

		const bullet = BULLET.exec(line);
		if (bullet) {
			blocks.push(textBlock("bulleted_list_item", bullet[1]));
			continue;
		}

		const numbered = NUMBERED.exec(line);
		if (numbered) {
			blocks.push(textBlock("numbered_list_item", numbered[1]));
			continue;
		}

		const quote = QUOTE.exec(line);
		if (quote) {
			blocks.push(textBlock("quote", quote[1]));
			continue;
		}

		blocks.push(textBlock("paragraph", line));
	}

	return blocks;
}

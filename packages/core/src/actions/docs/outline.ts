import type {
	DocsDocument,
	DocsParagraph,
	DocsStructuralElement,
	DocsTab,
} from "../../ports/docs.js";

// ---- Types -----------------------------------------------------------------

export type OutlineHeading = {
	type: "heading";
	level: string;
	text: string;
	startIndex: number;
	endIndex: number;
};

export type OutlineParagraph = {
	type: "paragraph";
	textPreview: string;
	startIndex: number;
	endIndex: number;
};

export type OutlineTable = {
	type: "table";
	rows: number;
	columns: number;
	startIndex: number;
	endIndex: number;
};

export type OutlineElement = OutlineHeading | OutlineParagraph | OutlineTable;

export type TabOutline = {
	tabId: string;
	title: string;
	depth: number;
	elements: OutlineElement[];
};

export type FlatTab = {
	tabId: string;
	title: string;
	depth: number;
	content: DocsStructuralElement[];
};

export type TextMatch = {
	tabId: string;
	tabTitle: string;
	startIndex: number;
	endIndex: number;
	matchedText: string;
	surroundingText: string;
};

// ---- Tab Flattening ---------------------------------------------------------

/**
 * Flatten the tab tree depth-first, preserving hierarchy depth.
 * Falls back to document body if tabs are empty (pre-tabs docs).
 */
export function flattenDocumentTabs(
	doc: DocsDocument,
	tabs: DocsTab[] | undefined | null = doc.tabs,
	depth = 0,
): FlatTab[] {
	if (!tabs || tabs.length === 0) {
		if (depth === 0) {
			return [
				{
					tabId: "",
					title: doc.title ?? "(main)",
					depth: 0,
					content: doc.body?.content ?? [],
				},
			];
		}
		return [];
	}

	const out: FlatTab[] = [];
	for (const tab of tabs) {
		const tabId = tab.tabProperties?.tabId ?? "";
		const title = tab.tabProperties?.title ?? "(untitled tab)";
		const content = tab.documentTab?.body?.content ?? [];
		out.push({ tabId, title, depth, content });
		if (tab.childTabs?.length) {
			out.push(...flattenDocumentTabs(doc, tab.childTabs, depth + 1));
		}
	}
	return out;
}

// ---- Outline Extraction -----------------------------------------------------

function extractParagraphText(p: DocsParagraph): string {
	return (p.elements ?? [])
		.map((e) => e.textRun?.content ?? "")
		.join("")
		.replace(/\v/g, "\n")
		.trimEnd();
}

export function extractStructuralOutline(
	content: DocsStructuralElement[] | undefined | null,
): OutlineElement[] {
	const elements: OutlineElement[] = [];

	for (const el of content ?? []) {
		const startIndex = el.startIndex ?? 0;
		const endIndex = el.endIndex ?? 0;

		if (el.paragraph) {
			const text = extractParagraphText(el.paragraph);
			const namedStyle =
				el.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";

			if (
				namedStyle === "TITLE" ||
				namedStyle === "SUBTITLE" ||
				namedStyle.startsWith("HEADING_")
			) {
				elements.push({
					type: "heading",
					level: namedStyle,
					text,
					startIndex,
					endIndex,
				});
			} else {
				// Regular paragraph
				const preview =
					text.length > 120 ? `${text.slice(0, 120)}…` : text;
				elements.push({
					type: "paragraph",
					textPreview: preview || "(empty)",
					startIndex,
					endIndex,
				});
			}
			continue;
		}

		if (el.table) {
			const rows = el.table.tableRows?.length ?? 0;
			const columns =
				el.table.tableRows?.[0]?.tableCells?.length ?? 0;
			elements.push({
				type: "table",
				rows,
				columns,
				startIndex,
				endIndex,
			});
			continue;
		}
	}

	return elements;
}

// ---- Find Text in Structural Elements ---------------------------------------

function searchParagraphForMatches(
	paragraph: DocsParagraph,
	query: string,
	matchCase: boolean,
	tabId: string,
	tabTitle: string,
	matches: TextMatch[],
): void {
	const charIndices: number[] = [];
	let fullText = "";

	for (const el of paragraph.elements ?? []) {
		const content = el.textRun?.content;
		const elStart = el.startIndex;
		if (content && typeof elStart === "number") {
			for (let i = 0; i < content.length; i++) {
				charIndices.push(elStart + i);
			}
			fullText += content;
		}
	}

	if (!fullText) return;

	const haystack = matchCase ? fullText : fullText.toLowerCase();
	const needle = matchCase ? query : query.toLowerCase();

	let pos = 0;
	while ((pos = haystack.indexOf(needle, pos)) !== -1) {
		const matchStart = charIndices[pos];
		const matchEnd = charIndices[pos + query.length - 1] + 1;
		const snippetStart = Math.max(0, pos - 40);
		const snippetEnd = Math.min(
			fullText.length,
			pos + query.length + 40,
		);
		const surrounding = fullText
			.slice(snippetStart, snippetEnd)
			.replace(/[\r\n\v]+/g, " ");

		matches.push({
			tabId,
			tabTitle,
			startIndex: matchStart,
			endIndex: matchEnd,
			matchedText: fullText.slice(pos, pos + query.length),
			surroundingText: surrounding,
		});

		pos += query.length;
	}
}

function searchElementsRecursive(
	elements: DocsStructuralElement[] | undefined | null,
	query: string,
	matchCase: boolean,
	tabId: string,
	tabTitle: string,
	matches: TextMatch[],
): void {
	for (const el of elements ?? []) {
		if (el.paragraph) {
			searchParagraphForMatches(
				el.paragraph,
				query,
				matchCase,
				tabId,
				tabTitle,
				matches,
			);
		}
		if (el.table) {
			for (const row of el.table.tableRows ?? []) {
				for (const cell of row.tableCells ?? []) {
					searchElementsRecursive(
						cell.content,
						query,
						matchCase,
						tabId,
						tabTitle,
						matches,
					);
				}
			}
		}
	}
}

export function findTextInDoc(
	doc: DocsDocument,
	query: string,
	options: { matchCase?: boolean; tabIdFilter?: string } = {},
): TextMatch[] {
	const matchCase = options.matchCase !== false;
	const allTabs = flattenDocumentTabs(doc);
	const targetTabs = options.tabIdFilter
		? allTabs.filter((t) => t.tabId === options.tabIdFilter)
		: allTabs;

	const matches: TextMatch[] = [];
	for (const tab of targetTabs) {
		searchElementsRecursive(
			tab.content,
			query,
			matchCase,
			tab.tabId,
			tab.title,
			matches,
		);
	}
	return matches;
}

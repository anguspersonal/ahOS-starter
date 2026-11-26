// Google Docs reader that returns EVERY tab.
//
// Why this exists next to drive.ts, which can already export a Doc to Markdown: Drive's
// `files.export` renders the document's default tab only. A Doc with tabs exports as if
// the other tabs were not there, and it does so silently — no error, no marker, just a
// short file. Gemini meeting notes are the case that matters here: the summary and the
// full transcript are separate tabs, so a Drive export of one drops the other on the
// floor and the loss is invisible downstream.
//
// The Docs API has `includeTabsContent`, which returns the tab tree. That flag is the
// whole reason for this module; the text extraction below is the unavoidable cost of
// using it, because the Docs API answers with a structural document model rather than
// with rendered text.
//
// Scope: the Docs API accepts the Drive scope already in google/scopes.ts, so this
// needs no new consent.

const DOCS_API = "https://docs.googleapis.com/v1/documents";

/**
 * Account-labelled token handle for Google Docs API calls.
 * `label` is used in error messages; `accessToken()` mints or returns a short-lived token.
 */
export type DocsAuth = {
	label: string;
	accessToken(): Promise<string>;
	fetchFn?: typeof fetch;
};

// ---- wire shapes (only the fields we read) ---------------------------------

type TextRun = { content?: string };
type Person = {
	personProperties?: {
		name?: string;
		email?: string;
	};
};
type RichLink = {
	richLinkProperties?: {
		title?: string;
		uri?: string;
	};
};
type DateElement = {
	dateElementProperties?: {
		displayText?: string;
		timestamp?: string;
	};
};
type ParagraphElement = {
	textRun?: TextRun;
	person?: Person;
	richLink?: RichLink;
	dateElement?: DateElement;
};
type Paragraph = {
	elements?: ParagraphElement[];
	paragraphStyle?: { namedStyleType?: string };
};
type TableCell = { content?: StructuralElement[] };
type TableRow = { tableCells?: TableCell[] };
type Table = { tableRows?: TableRow[] };
type StructuralElement = {
	paragraph?: Paragraph;
	table?: Table;
	tableOfContents?: { content?: StructuralElement[] };
};

type Tab = {
	tabProperties?: { tabId?: string; title?: string; index?: number };
	documentTab?: { body?: { content?: StructuralElement[] } };
	childTabs?: Tab[];
};

type DocsDocument = {
	documentId?: string;
	title?: string;
	tabs?: Tab[];
	body?: { content?: StructuralElement[] };
};

export type DocTab = { id: string; title: string; text: string; depth: number };

export type ReadDocResult = {
	documentId: string;
	title: string;
	tabs: DocTab[];
	/** Every tab concatenated, each under a `## <tab title>` heading. */
	text: string;
};

// ---- extraction --------------------------------------------------------------

/** Map the Docs named styles we care about onto Markdown heading prefixes. */
const HEADING_PREFIX: Record<string, string> = {
	TITLE: "# ",
	SUBTITLE: "## ",
	HEADING_1: "# ",
	HEADING_2: "## ",
	HEADING_3: "### ",
	HEADING_4: "#### ",
	HEADING_5: "##### ",
	HEADING_6: "###### ",
};

function renderParagraphElement(el: ParagraphElement): string {
	if (el.textRun?.content !== undefined) {
		return el.textRun.content;
	}
	if (el.person?.personProperties) {
		const { name, email } = el.person.personProperties;
		if (name && email) return `@${name} <${email}>`;
		if (email) return `@${email}`;
		if (name) return `@${name}`;
	}
	if (el.richLink?.richLinkProperties) {
		const { title, uri } = el.richLink.richLinkProperties;
		if (title && uri) return `[${title}](${uri})`;
		if (uri) return uri;
		if (title) return title;
	}
	if (el.dateElement?.dateElementProperties) {
		const { displayText, timestamp } = el.dateElement.dateElementProperties;
		if (displayText) return displayText;
		if (timestamp) return timestamp;
	}
	return "";
}

function paragraphText(p: Paragraph): string {
	const raw = (p.elements ?? [])
		.map(renderParagraphElement)
		.join("")
		.replace(/\v/g, "\n") // Docs uses a vertical tab for a soft line break.
		.trimEnd();
	if (!raw.trim()) return "";
	const prefix = HEADING_PREFIX[p.paragraphStyle?.namedStyleType ?? ""] ?? "";
	return `${prefix}${raw}`;
}

function elementsToText(content: StructuralElement[] | undefined): string {
	const lines: string[] = [];
	for (const el of content ?? []) {
		if (el.paragraph) {
			const t = paragraphText(el.paragraph);
			if (t) lines.push(t);
			continue;
		}
		if (el.table) {
			// Rendered as pipe rows rather than a real Markdown table: meeting notes use
			// tables for attendee and action-item grids, where the cell values are the
			// content and column alignment is not.
			for (const row of el.table.tableRows ?? []) {
				const cells = (row.tableCells ?? []).map((c) =>
					elementsToText(c.content).replace(/\n+/g, " ").trim(),
				);
				if (cells.some((c) => c)) lines.push(`| ${cells.join(" | ")} |`);
			}
			continue;
		}
		if (el.tableOfContents) {
			// Skipped deliberately: a ToC is a rendering of headings already present in
			// the body, so including it duplicates every heading in the extracted text.
			continue;
		}
	}
	return lines.join("\n");
}

/**
 * Flatten the tab tree depth-first, preserving order and nesting depth.
 *
 * Tabs nest: a Doc can have child tabs under a parent tab, and Gemini has begun using
 * that shape. A flat read of `document.tabs` would return the parents and silently drop
 * every child, which is the same failure this module exists to fix, one level down.
 */
function flattenTabs(tabs: Tab[] | undefined, depth = 0): DocTab[] {
	const out: DocTab[] = [];
	for (const tab of tabs ?? []) {
		out.push({
			id: tab.tabProperties?.tabId ?? "",
			title: tab.tabProperties?.title ?? "(untitled tab)",
			text: elementsToText(tab.documentTab?.body?.content),
			depth,
		});
		out.push(...flattenTabs(tab.childTabs, depth + 1));
	}
	return out;
}

// ---- read ---------------------------------------------------------------------

/**
 * Read a Google Doc as text, including every tab.
 *
 * Falls back to the top-level `body` when the response carries no `tabs` array, which
 * is what the API returns for a document created before tabs existed.
 */
export async function readDocument(
	documentId: string,
	auth: DocsAuth,
	fetchFn: typeof fetch = auth.fetchFn ?? globalThis.fetch,
): Promise<ReadDocResult> {
	const token = await auth.accessToken();

	const res = await fetchFn(
		`${DOCS_API}/${encodeURIComponent(documentId)}?includeTabsContent=true`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) {
		const detail = await res.text();
		// Docs returns 404 both for "no such document" and for "you cannot see it", so
		// the account is named: reading another account's doc is the likelier cause.
		throw Object.assign(
			new Error(
				`Google Docs API GET ${documentId} failed for account '${auth.label}' (${res.status}): ${detail}`,
			),
			{ status: res.status },
		);
	}
	const doc = (await res.json()) as DocsDocument;

	const tabs = flattenTabs(doc.tabs);
	if (tabs.length === 0) {
		const text = elementsToText(doc.body?.content);
		return {
			documentId: doc.documentId ?? documentId,
			title: doc.title ?? "(untitled)",
			tabs: [{ id: "", title: doc.title ?? "(untitled)", text, depth: 0 }],
			text,
		};
	}

	const text = tabs
		.map((t) => `${"#".repeat(Math.min(t.depth + 2, 6))} ${t.title}\n\n${t.text}`)
		.join("\n\n");

	return {
		documentId: doc.documentId ?? documentId,
		title: doc.title ?? "(untitled)",
		tabs,
		text,
	};
}

// Tab ids to three levels deep, the Docs editor's nesting limit. Only the ids come
// back, so counting a long Doc's tabs does not download its content. A tab nested
// deeper would be left out of the count, but its parent already makes the count
// more than one, and "more than one" is all drive_export acts on.
const TAB_COUNT_FIELDS =
	"tabs(tabProperties(tabId),childTabs(tabProperties(tabId),childTabs(tabProperties(tabId))))";

/**
 * How many tabs a Google Doc has, nested child tabs included, without reading their
 * content. A Doc from before tabs existed has no `tabs` array and counts as one.
 *
 * drive_export uses this to say when its file is partial: Drive's `files.export`
 * renders the default tab only (see the header of this module).
 */
export async function countDocumentTabs(
	documentId: string,
	auth: DocsAuth,
	fetchFn: typeof fetch = auth.fetchFn ?? globalThis.fetch,
): Promise<number> {
	const token = await auth.accessToken();
	const res = await fetchFn(
		`${DOCS_API}/${encodeURIComponent(documentId)}?includeTabsContent=true&fields=${encodeURIComponent(TAB_COUNT_FIELDS)}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) {
		const detail = await res.text();
		throw Object.assign(
			new Error(
				`Google Docs API GET ${documentId} (tab count) failed for account '${auth.label}' (${res.status}): ${detail}`,
			),
			{ status: res.status },
		);
	}
	const doc = (await res.json()) as DocsDocument;
	return Math.max(flattenTabs(doc.tabs).length, 1);
}

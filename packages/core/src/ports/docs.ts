import type { Domain } from "../domain/domains.js";

export interface DocsTextRun { content?: string | null }
export interface DocsPerson { personProperties?: { name?: string | null; email?: string | null } | null }
export interface DocsRichLink { richLinkProperties?: { title?: string | null; uri?: string | null } | null }
export interface DocsDateElement { dateElementProperties?: { displayText?: string | null; timestamp?: string | null } | null }

export interface DocsParagraphElement {
	startIndex?: number | null;
	endIndex?: number | null;
	textRun?: DocsTextRun | null;
	person?: DocsPerson | null;
	richLink?: DocsRichLink | null;
	dateElement?: DocsDateElement | null;
}

export interface DocsParagraphStyle { namedStyleType?: string | null }
export interface DocsParagraph { elements?: DocsParagraphElement[] | null; paragraphStyle?: DocsParagraphStyle | null }
export interface DocsTableCell { content?: DocsStructuralElement[] | null }
export interface DocsTableRow { tableCells?: DocsTableCell[] | null }
export interface DocsTable { rows?: number | null; columns?: number | null; tableRows?: DocsTableRow[] | null }
export interface DocsTableOfContents { content?: DocsStructuralElement[] | null }

export interface DocsStructuralElement {
	startIndex?: number | null;
	endIndex?: number | null;
	paragraph?: DocsParagraph | null;
	table?: DocsTable | null;
	tableOfContents?: DocsTableOfContents | null;
}

export interface DocsBody { content?: DocsStructuralElement[] | null }
export interface DocsTabProperties { tabId?: string | null; title?: string | null; index?: number | null }
export interface DocsDocumentTab { body?: DocsBody | null }

export interface DocsTab {
	tabProperties?: DocsTabProperties | null;
	documentTab?: DocsDocumentTab | null;
	childTabs?: DocsTab[] | null;
}

export interface DocsDocument {
	documentId?: string | null;
	title?: string | null;
	revisionId?: string | null;
	tabs?: DocsTab[] | null;
	body?: DocsBody | null;
}

export type DocsSuggestionsViewMode =
	| "DEFAULT_FOR_CURRENT_ACCESS"
	| "SUGGESTIONS_INLINE"
	| "PREVIEW_SUGGESTIONS_ACCEPTED"
	| "PREVIEW_WITHOUT_SUGGESTIONS"
	| string;

export interface DocsApiError extends Error {
	name: "DocsApiError";
	status: number;
	googleStatus?: string;
	reason?: string;
}

export interface GetDocumentParams {
	domain: Domain;
	documentId: string;
	includeTabsContent?: boolean;
	suggestionsViewMode?: DocsSuggestionsViewMode;
	fields?: string;
}

export type DocsGetDocumentParams = GetDocumentParams;

export interface DocsWriteControl {
	requiredRevisionId?: string | null;
	targetRevisionId?: string | null;
	writeMode?: "SUGGEST" | "EDIT" | string;
}

export type DocsBatchUpdateRequest = Record<string, unknown>;
export type DocsBatchUpdateReply = Record<string, unknown>;

export interface DocsBatchUpdateResponse {
	documentId?: string | null;
	writeControl?: DocsWriteControl | null;
	replies?: DocsBatchUpdateReply[] | null;
	revisionId?: string | null;
}

export interface BatchUpdateDocumentParams {
	domain: Domain;
	documentId: string;
	requests: DocsBatchUpdateRequest[];
	writeControl?: DocsWriteControl;
}

export type DocsBatchUpdateParams = BatchUpdateDocumentParams;

export interface DocsPort {
	getDocument(params: GetDocumentParams): Promise<DocsDocument>;
	batchUpdate?(params: BatchUpdateDocumentParams): Promise<DocsBatchUpdateResponse>;
}


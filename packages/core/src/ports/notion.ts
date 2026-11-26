import type { Domain } from "../domain/domains.js";

/**
 * Structured error thrown by NotionPort implementations when a Notion API call fails (#1569).
 * Actions branch on `status` and `code`, never on message text (ADR-102 §3).
 */
export interface NotionApiError extends Error {
	name: "NotionApiError";
	status?: number;
	code?: string;
}

/**
 * Common search result item from Notion API search (ADR-101).
 * Pure domain DTO: independent of specific SDK types.
 */
export interface NotionSearchResultItem {
	id: string;
	object: "page" | "database" | "data_source" | string;
	url?: string;
	last_edited_time?: string;
	archived?: boolean;
	title?: unknown;
	properties?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface NotionSearchResponse {
	results: NotionSearchResultItem[];
	has_more: boolean;
	next_cursor?: string | null;
}

export interface NotionSearchParams {
	workspace: string;
	query?: string;
	objectType?: "page" | "database" | "data_source";
	pageSize?: number;
	cursor?: string;
}

export interface NotionPagePropertyItem {
	type?: string;
	[key: string]: unknown;
}

export interface NotionPageResponse {
	id: string;
	url?: string;
	last_edited_time?: string;
	archived?: boolean;
	parent?: { type?: string; [key: string]: unknown };
	properties?: Record<string, NotionPagePropertyItem>;
	[key: string]: unknown;
}

export interface NotionRetrievePageParams {
	workspace: string;
	pageId: string;
}

export interface NotionBlockParent {
	type?: "page_id" | "block_id" | "database_id" | "workspace" | string;
	page_id?: string;
	block_id?: string;
	database_id?: string;
	[key: string]: unknown;
}

export interface NotionBlockItem {
	id: string;
	type: string;
	has_children?: boolean;
	archived?: boolean;
	parent?: NotionBlockParent;
	[key: string]: unknown;
}

/**
 * One rich-text run on a block. `plain_text` is what Notion returns; `text.content`
 * is what it accepts on write. Both are read so a run read back from the API can be
 * re-sent without a lossy round-trip, and `annotations` / `text.link` are carried
 * through so a rewrite of one line leaves the formatting of neighbouring runs intact.
 */
export type NotionRichTextRun = {
	type?: string;
	text?: { content?: string; link?: { url: string } | null };
	plain_text?: string;
	annotations?: Record<string, unknown>;
	href?: string | null;
};

/** A block as returned by GET /v1/blocks/{id}/children. Type-specific payload is open. */
export type NotionBlock = {
	id: string;
	type: string;
	has_children?: boolean;
	archived?: boolean;
} & Record<string, unknown>;

export {
	buildHeadingBlock,
	markdownToBlocks,
	NOTION_TEXT_LIMIT,
	richTextRuns,
	textBlock,
	type BlockPayload,
	type HeadingLevel,
	type NotionInlineAnnotations,
	type RichTextRun,
} from "../actions/notion/blocks.js";

export interface NotionRetrieveBlockParams {
	workspace: string;
	blockId: string;
}

export interface NotionDeleteBlockParams {
	workspace: string;
	blockId: string;
}

export interface NotionCommentItem {
	id: string;
	discussion_id?: string;
	created_time?: string;
	created_by?: { id: string; [key: string]: unknown };
	rich_text?: Array<{
		plain_text?: string;
		text?: { content?: string };
		[key: string]: unknown;
	}>;
	[key: string]: unknown;
}

export interface NotionListCommentsParams {
	workspace: string;
	blockId: string;
	pageSize?: number;
	cursor?: string;
}

export interface NotionListCommentsResponse {
	results: NotionCommentItem[];
	has_more: boolean;
	next_cursor?: string | null;
}

export interface NotionCreateCommentParams {
	workspace: string;
	parent?: { page_id: string } | { block_id: string };
	discussion_id?: string;
	rich_text: Array<Record<string, unknown>>;
}

export interface NotionCommentResponse {
	id: string;
	discussion_id?: string;
	created_time?: string;
	[key: string]: unknown;
}

export interface NotionBlockChildrenResponse {
	results: NotionBlockItem[];
	has_more: boolean;
	next_cursor?: string | null;
}

export interface NotionListBlockChildrenParams {
	workspace: string;
	blockId: string;
	pageSize?: number;
	maxBlocks?: number;
	cursor?: string;
}

export interface NotionDatabasePropertyOption {
	id?: string;
	name: string;
	color?: string;
}

export interface NotionDatabasePropertyItem {
	id?: string;
	name?: string;
	type?: string;
	select?: { options?: NotionDatabasePropertyOption[] };
	multi_select?: { options?: NotionDatabasePropertyOption[] };
	status?: { options?: NotionDatabasePropertyOption[] };
	[key: string]: unknown;
}

export interface NotionDatabaseResponse {
	id: string;
	title?: unknown;
	properties?: Record<string, NotionDatabasePropertyItem>;
	data_sources?: Array<{ id: string; name?: string }>;
	[key: string]: unknown;
}

export interface NotionRetrieveDatabaseParams {
	workspace: string;
	databaseId: string;
}

export interface NotionDataSourceResponse {
	id: string;
	parent?: { database_id?: string; type?: string; [key: string]: unknown };
	properties?: Record<string, NotionDatabasePropertyItem>;
	[key: string]: unknown;
}

export interface NotionRetrieveDataSourceParams {
	workspace: string;
	dataSourceId: string;
}

export interface NotionQueryDataSourceParams {
	workspace: string;
	dataSourceId: string;
	pageSize?: number;
	cursor?: string;
	filter?: Record<string, unknown>;
	sorts?: Array<Record<string, unknown>>;
}

export interface NotionQueryDataSourceResponse {
	results: NotionPageResponse[];
	has_more: boolean;
	next_cursor?: string | null;
}

export interface NotionCreatePageParams {
	workspace: string;
	databaseId?: string;
	parentPageId?: string;
	properties: Record<string, unknown>;
	children?: Array<Record<string, unknown>>;
	icon?: { emoji: string };
}

export interface NotionCreatedPageResponse {
	id: string;
	url: string;
	[key: string]: unknown;
}

export interface NotionAppendBlockChildrenParams {
	workspace: string;
	blockId: string;
	children: Array<Record<string, unknown>>;
	after?: string;
}

export interface NotionUpdateBlockParams {
	workspace: string;
	blockId: string;
	payload: Record<string, unknown>;
}

export interface NotionUpdatePageParams {
	workspace: string;
	pageId: string;
	properties?: Record<string, unknown>;
	icon?: Record<string, unknown> | null;
	archived?: boolean;
}

export interface NotionUser {
	id: string;
	name: string;
	type: string;
	email?: string;
}

export interface NotionListUsersParams {
	workspace: string;
}

/**
 * Notion Port (ADR-101 §1).
 * Pure interface for Notion operations required by core actions.
 * Zero Node built-ins, zero external SDK dependencies.
 */
export interface NotionPort {
	/**
	 * Resolve an access token for the given workspace ('work' | 'angus').
	 */
	resolveToken(workspace: string): Promise<string>;

	/**
	 * Search Notion pages and databases by title or recent edits.
	 */
	search(params: NotionSearchParams): Promise<NotionSearchResponse>;

	/**
	 * Retrieve a page envelope and properties by page ID.
	 */
	retrievePage(params: NotionRetrievePageParams): Promise<NotionPageResponse>;

	/**
	 * List child blocks of a page or block container.
	 */
	listBlockChildren(params: NotionListBlockChildrenParams): Promise<NotionBlockChildrenResponse>;

	/**
	 * Retrieve a database schema by database ID.
	 */
	retrieveDatabase(params: NotionRetrieveDatabaseParams): Promise<NotionDatabaseResponse>;

	/**
	 * Retrieve a data source by ID to resolve its parent database or metadata.
	 */
	retrieveDataSource(params: NotionRetrieveDataSourceParams): Promise<NotionDataSourceResponse>;

	/**
	 * Query a data source with filters, sorts, and cursor pagination.
	 */
	queryDataSource(params: NotionQueryDataSourceParams): Promise<NotionQueryDataSourceResponse>;

	/**
	 * Retrieve a single block by block ID.
	 */
	retrieveBlock(params: NotionRetrieveBlockParams): Promise<NotionBlockItem>;

	/**
	 * Delete (move to trash) a block by block ID.
	 */
	deleteBlock(params: NotionDeleteBlockParams): Promise<NotionBlockItem>;

	/**
	 * List comments attached to a page or block.
	 */
	listComments(params: NotionListCommentsParams): Promise<NotionListCommentsResponse>;

	/**
	 * Create a comment on a page, block, or reply to a discussion thread.
	 */
	createComment(params: NotionCreateCommentParams): Promise<NotionCommentResponse>;

	/**
	 * Create a page under a database or a parent page (#1572).
	 */
	createPage(params: NotionCreatePageParams): Promise<NotionCreatedPageResponse>;

	/**
	 * Append block children to a page or block in chunks of at most 100 (#1572).
	 * Returns the created block IDs.
	 */
	appendBlockChildren(params: NotionAppendBlockChildrenParams): Promise<string[]>;

	/**
	 * Rewrite one block in place by block ID (#1574).
	 */
	updateBlock(params: NotionUpdateBlockParams): Promise<void>;

	/**
	 * Patch page properties, icon, and/or archived (trash) state in a single request (#1574).
	 */
	updatePage(params: NotionUpdatePageParams): Promise<void>;

	/**
	 * List all users visible to the workspace integration, following cursor pagination (#1570).
	 */
	listUsers(params: NotionListUsersParams): Promise<NotionUser[]>;

	/**
	 * Optional hook to resolve the State Doc page ID for a workspace.
	 * When unwired (missing on port), write actions fail closed (#1572).
	 */
	getStateDocPageId?(workspace: string): Promise<string | undefined>;

	/**
	 * Optional hook to resolve the Daily Log target IDs (database ID and data source ID) for a workspace (#1572).
	 * When unwired (missing on port), write actions fail closed (#1572).
	 */
	getDailyLogTargetIds?(workspace: string): Promise<string[]>;

	/**
	 * Resolve a domain + record kind to its data source ID, database ID, and workspace (#1576).
	 * No token crosses into core.
	 */
	resolveRecordTarget?(
		kind: NotionRecordKind,
		domain: Domain,
	): Promise<NotionResolvedRecordTarget>;

	/**
	 * Resolve a domain's Daily Log target to its database ID, optional data source ID, and workspace (#1576).
	 * No token crosses into core.
	 */
	resolveDailyLogTarget?(domain: Domain): Promise<NotionResolvedDailyLogTarget>;
}

export type NotionRecordKind = "meetings" | "contacts" | "investor_crm";

export interface NotionResolvedRecordTarget {
	dataSourceId: string;
	databaseId: string;
	workspace: Domain;
}

export interface NotionResolvedDailyLogTarget {
	dataSourceId?: string;
	databaseId: string;
	workspace: Domain;
}

export interface NotionRecordTargets {
	resolveRecordTarget(
		kind: NotionRecordKind,
		domain: Domain,
	): Promise<NotionResolvedRecordTarget>;
	resolveDailyLogTarget(domain: Domain): Promise<NotionResolvedDailyLogTarget>;
}

export * from "../domain/dosConfigDrift.js";
export * from "../domain/tasksPropertyDrift.js";


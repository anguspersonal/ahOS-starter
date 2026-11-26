import { z } from "zod";
import type { OneDriveItemList, OneDrivePort } from "../../ports/onedrive.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export const onedriveListInputSchema = z.object({
	folder_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"OneDrive folder item ID to list children of (defaults to 'root' when path is not provided).",
		),
	path: z
		.string()
		.min(1)
		.optional()
		.describe(
			"OneDrive root-relative folder path to list children of (for example '/1.Projects' or '1.Projects'). When provided, takes precedence over folder_id.",
		),
	page_size: z
		.number()
		.int()
		.min(1)
		.max(MAX_PAGE_SIZE)
		.optional()
		.describe(
			`Maximum number of items per page (1..${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE}).`,
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe("Continuation cursor (nextCursor) from a previous onedrive_list response."),
	order_by: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional OData orderby clause (for example 'name asc' or 'lastModifiedDateTime desc').",
		),
});

export type OnedriveListInput = z.infer<typeof onedriveListInputSchema>;

/**
 * Create the `onedrive_list` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveListAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveListInputSchema, OneDriveItemList> {
	return defineAction({
		id: "onedrive_list",
		name: "onedrive_list",
		description:
			"List children of a personal OneDrive folder by folder_id (default 'root') or root-relative path with cursor pagination.",
		domain: "integrations",
		schema: onedriveListInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveListInput,
			_context: ActionContext,
		): Promise<OneDriveItemList> {
			return port.listChildren({
				folderId: input.path ? undefined : (input.folder_id ?? "root"),
				path: input.path,
				pageSize: input.page_size ?? DEFAULT_PAGE_SIZE,
				cursor: input.cursor,
				orderBy: input.order_by,
			});
		},
	});
}

export const onedriveSearchInputSchema = z.object({
	query: z
		.string()
		.min(1)
		.describe("Search query string matched against personal OneDrive item names and contents."),
	folder_id: z
		.string()
		.min(1)
		.optional()
		.describe("Optional OneDrive folder item ID to scope the search subtree (defaults to 'root')."),
	page_size: z
		.number()
		.int()
		.min(1)
		.max(MAX_PAGE_SIZE)
		.optional()
		.describe(
			`Maximum number of items per page (1..${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE}).`,
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe("Continuation cursor (nextCursor) from a previous onedrive_search response."),
});

export type OnedriveSearchInput = z.infer<typeof onedriveSearchInputSchema>;

/**
 * Create the `onedrive_search` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveSearchAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveSearchInputSchema, OneDriveItemList> {
	return defineAction({
		id: "onedrive_search",
		name: "onedrive_search",
		description:
			"Search personal OneDrive items by query string across the drive or within a specific folder_id.",
		domain: "integrations",
		schema: onedriveSearchInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveSearchInput,
			_context: ActionContext,
		): Promise<OneDriveItemList> {
			const query = input.query.trim();
			if (!query) {
				throw new Error("onedrive_search requires a non-empty query string");
			}
			return port.searchItems({
				query,
				folderId: input.folder_id,
				pageSize: input.page_size ?? DEFAULT_PAGE_SIZE,
				cursor: input.cursor,
			});
		},
	});
}

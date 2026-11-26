import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import {
	formatList,
	LIST_FIELDS,
	type DriveFile,
	type DriveFileList,
	type DrivePort,
} from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

function formatResult(
	toolName: "drive_list" | "drive_search",
	files: DriveFile[],
	nextPageToken?: string | null,
	incompleteSearch?: boolean | null,
): string {
	const lines = [formatList(files)];
	if (nextPageToken) {
		lines.push(
			`More files exist. Call ${toolName} again with the same arguments plus cursor '${nextPageToken}' for the next page; do not treat this list as complete.`,
		);
	}
	if (incompleteSearch) {
		lines.push(
			"Drive searched only part of the corpus; results may be missing.",
		);
	}
	return lines.join("\n");
}

// Drive query strings require single quotes around values to be escaped as \'.
export function escapeDriveQueryValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---- drive_list -----------------------------------------------------------

export const driveListInput = {
	folder_id: z
		.string()
		.optional()
		.describe(
			"Optional folder id to list children of. Use 'root' for My Drive top level. Omit to list across all of Drive.",
		),
	q: z
		.string()
		.optional()
		.describe(
			"Optional raw Drive query (files.list q syntax), e.g. \"name = 'X.docx'\" or \"mimeType = 'application/pdf'\". ANDed with folder_id and, unless include_trashed, trashed = false.",
		),
	cursor: z
		.string()
		.optional()
		.describe(
			"Opaque cursor from a previous call's 'More files exist' line. Pass it with the same other arguments; omit for the first page.",
		),
	include_trashed: z
		.boolean()
		.optional()
		.describe("Include trashed files (default false)."),
	page_size: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max files to return (default 25)."),
	order_by: z
		.string()
		.optional()
		.describe(
			"Drive orderBy expression, e.g. 'modifiedTime desc' (default), 'name', 'folder,name'.",
		),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveListInputSchema = z.object(driveListInput);
export const driveListSchema = driveListInputSchema;
export type DriveListInput = z.infer<typeof driveListInputSchema>;
export interface DriveListOutput extends DriveFileList {
	file_ids: string[];
	count: number;
}

export function formatDriveListMcp(out: DriveFileList): string {
	return formatResult(
		"drive_list",
		out.files ?? [],
		out.nextPageToken,
		out.incompleteSearch,
	);
}

export function createDriveListAction(
	port: DrivePort,
): ActionDefinition<typeof driveListInputSchema, DriveListOutput> {
	return defineAction({
		id: "drive_list",
		domain: "integrations",
		description:
			"List Google Drive files, optionally within a folder (use folder_id 'root' for My Drive top level).",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveListInputSchema,
		formatMcp: formatDriveListMcp,
		async run(input) {
			const domain =
				reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const clauses: string[] = [];
			if (input.q) clauses.push(`(${input.q})`);
			if (input.folder_id) clauses.push(`'${input.folder_id}' in parents`);
			if (!input.include_trashed) clauses.push("trashed = false");

			const res = await port.listFiles({
				domain,
				q: clauses.length ? clauses.join(" and ") : undefined,
				pageSize: input.page_size ?? 25,
				orderBy: input.order_by ?? "modifiedTime desc",
				pageToken: input.cursor,
				fields: LIST_FIELDS,
			});
			const files = res.files ?? [];
			return {
				files,
				file_ids: files.map((f) => f.id).filter((id): id is string => Boolean(id)),
				count: files.length,
				...(res.nextPageToken !== undefined
					? { nextPageToken: res.nextPageToken }
					: {}),
				...(res.incompleteSearch !== undefined
					? { incompleteSearch: res.incompleteSearch }
					: {}),
			};
		},
	});
}

// ---- drive_search ---------------------------------------------------------

export const driveSearchInput = {
	query: z
		.string()
		.min(1)
		.describe(
			"Text to find in file name and full-text content. Matched with Drive's fullText/name contains operators.",
		),
	cursor: z
		.string()
		.optional()
		.describe(
			"Opaque cursor from a previous call's 'More files exist' line. Pass it with the same other arguments; omit for the first page.",
		),
	mime_type: z
		.string()
		.optional()
		.describe(
			"Optional exact mimeType filter, e.g. 'application/pdf' or 'application/vnd.google-apps.folder'.",
		),
	include_trashed: z
		.boolean()
		.optional()
		.describe("Include trashed files (default false)."),
	page_size: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max files to return (default 25)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveSearchInputSchema = z.object(driveSearchInput);
export const driveSearchSchema = driveSearchInputSchema;
export type DriveSearchInput = z.infer<typeof driveSearchInputSchema>;
export type DriveSearchOutput = DriveListOutput;

export function formatDriveSearchMcp(out: DriveFileList): string {
	return formatResult(
		"drive_search",
		out.files ?? [],
		out.nextPageToken,
		out.incompleteSearch,
	);
}

export function createDriveSearchAction(
	port: DrivePort,
): ActionDefinition<typeof driveSearchInputSchema, DriveSearchOutput> {
	return defineAction({
		id: "drive_search",
		domain: "integrations",
		description:
			"Search Google Drive by file name and full-text content, optionally filtered by MIME type.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveSearchInputSchema,
		formatMcp: formatDriveSearchMcp,
		async run(input) {
			const domain =
				reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const safe = escapeDriveQueryValue(input.query);
			// fullText covers body/content; name contains catches matches the index misses.
			const clauses: string[] = [
				`(fullText contains '${safe}' or name contains '${safe}')`,
			];
			if (input.mime_type) {
				clauses.push(`mimeType = '${escapeDriveQueryValue(input.mime_type)}'`);
			}
			if (!input.include_trashed) clauses.push("trashed = false");

			const res = await port.listFiles({
				domain,
				q: clauses.join(" and "),
				pageSize: input.page_size ?? 25,
				orderBy: "modifiedTime desc",
				pageToken: input.cursor,
				fields: LIST_FIELDS,
			});
			const files = res.files ?? [];
			return {
				files,
				file_ids: files.map((f) => f.id).filter((id): id is string => Boolean(id)),
				count: files.length,
				...(res.nextPageToken !== undefined
					? { nextPageToken: res.nextPageToken }
					: {}),
				...(res.incompleteSearch !== undefined
					? { incompleteSearch: res.incompleteSearch }
					: {}),
			};
		},
	});
}

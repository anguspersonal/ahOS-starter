import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain } from "../../domain/domains.js";
import type { DriveChangesPort } from "../../ports/driveWatch.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

export const driveChangesListInput = {
	domain: optionalDomainInput,
	account: googleAccountInput,
	cursor: z
		.string()
		.min(1)
		.describe(
			"Drive changes page token (from startPageToken or a previous drive_changes_list next_cursor / new_start_page_token).",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(1000)
		.optional()
		.describe("Maximum number of change entries to return (1-1000, default 200)."),
};

export const driveChangesListInputSchema = z.object(driveChangesListInput);
export const driveChangesListSchema = driveChangesListInputSchema;
export type DriveChangesListInput = z.infer<typeof driveChangesListInputSchema>;

export interface DriveChangeEntry {
	file_id: string;
	removed: boolean;
	trashed: boolean;
	time?: string;
	name?: string;
	mime_type?: string;
}

export type DriveChangesListOutput =
	| {
			expired: true;
	  }
	| {
			changes: DriveChangeEntry[];
			next_cursor: string | null;
			new_start_page_token: string | null;
	  };

export function formatDriveChangesListMcp(out: DriveChangesListOutput): string {
	if ("expired" in out) {
		return "Drive change token expired or invalid.";
	}
	const lines = [`Drive changes (${out.changes.length}):`];
	for (const c of out.changes) {
		const status = c.removed ? "removed" : c.trashed ? "trashed" : "changed";
		const label = c.name ? `${c.name} (${c.file_id})` : c.file_id;
		lines.push(`- [${status}] ${label}${c.time ? ` @ ${c.time}` : ""}`);
	}
	if (out.next_cursor) {
		lines.push(`next_cursor: ${out.next_cursor}`);
	}
	if (out.new_start_page_token) {
		lines.push(`new_start_page_token: ${out.new_start_page_token}`);
	}
	return lines.join("\n");
}

function isExpiredTokenError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const status = (err as { status?: number; code?: number }).status ?? (err as { code?: number }).code;
	if (status === 400 || status === 404) return true;
	const msg = err instanceof Error ? err.message : String(err);
	return /\b(400|404)\b/.test(msg) && /changes\.list|Invalid Value|pageToken/i.test(msg);
}

export function createDriveChangesListAction(
	port: DriveChangesPort,
): ActionDefinition<typeof driveChangesListInputSchema, DriveChangesListOutput> {
	return defineAction({
		id: "drive_changes_list",
		domain: "integrations",
		description:
			"Read Google Drive's changes.list feed from a page token cursor, including removed and trashed items across all drives.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: driveChangesListInputSchema,
		formatMcp: formatDriveChangesListMcp,
		async run(input) {
			const domain =
				reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const account = DOMAIN_LEGACY_SCOPE[domain];
			const limit = input.limit ?? 200;

			const changes: DriveChangeEntry[] = [];
			let currentToken: string | null = input.cursor;
			let nextCursor: string | null = null;
			let newStartPageToken: string | null = null;

			while (currentToken && changes.length < limit) {
				const remaining = Math.min(limit - changes.length, 1000);
				let page;
				try {
					page = await port.listChanges({
						account,
						pageToken: currentToken,
						pageSize: remaining,
						includeRemoved: true,
						includeItemsFromAllDrives: true,
					});
				} catch (err) {
					if (isExpiredTokenError(err)) {
						return { expired: true };
					}
					throw err;
				}

				if ("expired" in page && page.expired) {
					return { expired: true };
				}

				for (const raw of page.changes ?? []) {
					const fileId = raw.fileId ?? raw.file?.id ?? "";
					const removed = Boolean(raw.removed);
					const trashed = Boolean(raw.file?.trashed);
					const time = raw.time ?? raw.file?.modifiedTime ?? undefined;
					const entry: DriveChangeEntry = {
						file_id: fileId,
						removed,
						trashed,
						...(time ? { time } : {}),
						...(!removed && raw.file?.name !== undefined && raw.file?.name !== null
							? { name: raw.file.name }
							: {}),
						...(!removed &&
						raw.file?.mimeType !== undefined &&
						raw.file?.mimeType !== null
							? { mime_type: raw.file.mimeType }
							: {}),
					};
					changes.push(entry);
				}

				if (page.newStartPageToken) {
					newStartPageToken = page.newStartPageToken;
				}

				if (page.nextPageToken) {
					if (changes.length >= limit) {
						nextCursor = page.nextPageToken;
						break;
					}
					currentToken = page.nextPageToken;
				} else {
					nextCursor = null;
					currentToken = null;
				}
			}

			return {
				changes,
				next_cursor: nextCursor,
				new_start_page_token: newStartPageToken,
			};
		},
	});
}

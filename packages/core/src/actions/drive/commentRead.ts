import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import { DriveApiError, type DriveComment, type DriveCommentReply, type DrivePort } from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const MAX_COMMENT_CHARS = 2_000;
const MAX_QUOTED_CHARS = 500;
const MAX_EMBEDDED_REPLIES = 20;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const domainField = z.enum(DOMAINS).describe("Google Workspace domain ('work' or 'angus')");
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export interface DriveCommentReplyItem {
	id: string; author: string | null; author_is_me: boolean; content: string;
	content_truncated: boolean; action: string | null; created_at: string | null; modified_at: string | null;
}

export interface DriveCommentSummary {
	id: string; author: string | null; author_is_me: boolean; content: string; content_truncated: boolean;
	quoted_text: string | null; resolved: boolean; created_at: string | null; modified_at: string | null;
	reply_count: number; replies: DriveCommentReplyItem[]; replies_truncated: boolean;
}

const redactSecrets = (msg: string): string => msg.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");

function explainDriveCommentError(err: unknown, domain: Domain, fileId: string): never {
	if (err !== null && typeof err === "object" && typeof (err as { status?: unknown }).status === "number") {
		const { status, reason, googleStatus } = err as { status: number; reason?: string; googleStatus?: string };
		if (status === 404) {
			throw new DriveApiError(`File or comment '${fileId}' not found in the ${domain} account, or not shared with it (HTTP 404).`, 404, reason, googleStatus);
		}
		if (status === 403 && (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
			throw new DriveApiError(`Google Drive token for '${domain}' lacks required scope ${DRIVE_SCOPE} (HTTP 403, ${reason}).`, 403, reason, googleStatus);
		}
		if (err instanceof DriveApiError) throw new DriveApiError(redactSecrets(err.message), err.status, err.reason, err.googleStatus);
	}
	if (err instanceof Error && /Bearer\s+\S+/i.test(err.message)) throw new Error(redactSecrets(err.message));
	throw err;
}

function mapReply(r: DriveCommentReply): DriveCommentReplyItem {
	const raw = r.content ?? "";
	const content_truncated = raw.length > MAX_COMMENT_CHARS;
	return {
		id: r.id ?? "", author: r.author?.displayName ?? r.author?.emailAddress ?? null, author_is_me: Boolean(r.author?.me),
		content: content_truncated ? raw.slice(0, MAX_COMMENT_CHARS) : raw, content_truncated,
		action: r.action ?? null, created_at: r.createdTime ?? null, modified_at: r.modifiedTime ?? null,
	};
}

function mapComment(c: DriveComment): DriveCommentSummary {
	const raw = c.content ?? "";
	const content_truncated = raw.length > MAX_COMMENT_CHARS;
	const quotedRaw = c.quotedFileContent?.value ?? null;
	const liveReplies = (c.replies ?? []).filter((r) => !r.deleted);
	return {
		id: c.id ?? "", author: c.author?.displayName ?? c.author?.emailAddress ?? null, author_is_me: Boolean(c.author?.me),
		content: content_truncated ? raw.slice(0, MAX_COMMENT_CHARS) : raw, content_truncated,
		quoted_text: quotedRaw === null ? null : quotedRaw.slice(0, MAX_QUOTED_CHARS), resolved: Boolean(c.resolved),
		created_at: c.createdTime ?? null, modified_at: c.modifiedTime ?? null, reply_count: liveReplies.length,
		replies: liveReplies.slice(0, MAX_EMBEDDED_REPLIES).map(mapReply), replies_truncated: liveReplies.length > MAX_EMBEDDED_REPLIES,
	};
}

export const driveCommentListInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID (Doc, Sheet, Slides, PDF, or binary)"),
	include_resolved: z.boolean().optional().describe("Include resolved comment threads when true (default false)"),
	limit: z.number().int().min(1).max(100).optional().describe("Maximum matching comments to return (1-100, default 20)"),
	cursor: z.string().min(1).optional().describe("Pagination cursor from a previous drive_comment_list call"),
});
export type DriveCommentListInput = z.infer<typeof driveCommentListInputSchema>;
export interface DriveCommentListOutput {
	domain: Domain; file_id: string; include_resolved: boolean; comments: DriveCommentSummary[]; scanned: number; next_cursor: string | null;
}

export function formatDriveCommentListMcp(out: DriveCommentListOutput): string {
	if (out.comments.length === 0) {
		if (out.scanned === 0 && out.next_cursor === null) return `No comments on file ${out.file_id} (${out.domain}).`;
		if (out.next_cursor !== null) {
			return `No comments match the filter (${out.include_resolved ? "all" : "unresolved"}) in ${out.scanned} scanned comment(s) on file ${out.file_id} (${out.domain}); more comments may exist on later pages (next_cursor=${out.next_cursor}).`;
		}
		return `No comments match the filter (unresolved) out of ${out.scanned} comment(s) on file ${out.file_id} (${out.domain}).`;
	}
	return [
		`Comments on ${out.domain}:${out.file_id} (${out.comments.length} returned, ${out.scanned} scanned${out.next_cursor ? `, next_cursor=${out.next_cursor}` : ""}):`,
		...out.comments.map((c) => `- [${c.id}] ${c.author ?? "Unknown"}${c.resolved ? " (resolved)" : ""}: "${c.content}" (${c.reply_count} repl${c.reply_count === 1 ? "y" : "ies"})`),
	].join("\n");
}

export function createDriveCommentListAction(port: DrivePort): ActionDefinition<typeof driveCommentListInputSchema, DriveCommentListOutput> {
	return defineAction({
		id: "drive_comment_list", name: "List Google Drive File Comments", domain: "integrations",
		description: "List unresolved or all comment threads on any Google Drive file (Doc, Sheet, Slides, PDF), paging up to five pages per call until limit matches are found. Requires domain ('work' or 'angus'). Full notes: docs/guides/tools/drive_comment_list.md",
		annotations: READ_ANNOTATIONS, schema: driveCommentListInputSchema, formatMcp: formatDriveCommentListMcp,
		run: async (input): Promise<DriveCommentListOutput> => {
			const includeResolved = Boolean(input.include_resolved);
			const limit = input.limit ?? 20;
			let pageToken: string | undefined = input.cursor;
			let scanned = 0;
			const comments: DriveCommentSummary[] = [];
			for (let page = 0; page < MAX_PAGES && comments.length < limit; page++) {
				const res = await port.listComments!({
					domain: input.domain, fileId: input.file_id, pageSize: PAGE_SIZE, pageToken, includeDeleted: false,
				}).catch((err) => explainDriveCommentError(err, input.domain, input.file_id));
				const batch = res.comments ?? [];
				scanned += batch.length;
				for (const item of batch) {
					if (!item.deleted && (includeResolved || !item.resolved) && comments.length < limit) comments.push(mapComment(item));
				}
				pageToken = res.nextPageToken ?? undefined;
				if (!pageToken) break;
			}
			return { domain: input.domain, file_id: input.file_id, include_resolved: includeResolved, comments, scanned, next_cursor: pageToken ?? null };
		},
	});
}

export const driveCommentGetInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID"),
	comment_id: z.string().min(1).describe("Google Drive comment ID"),
	reply_cursor: z.string().min(1).optional().describe("Pagination cursor for replies from a previous drive_comment_get call"),
});
export type DriveCommentGetInput = z.infer<typeof driveCommentGetInputSchema>;
export interface DriveCommentGetOutput {
	domain: Domain; file_id: string; comment: Omit<DriveCommentSummary, "reply_count" | "replies_truncated">; next_reply_cursor: string | null;
}

export const formatDriveCommentGetMcp = (out: DriveCommentGetOutput): string =>
	`Comment ${out.comment.id} on ${out.domain}:${out.file_id} by ${out.comment.author ?? "Unknown"}${out.comment.resolved ? " (resolved)" : ""}: "${out.comment.content}" (${out.comment.replies.length} repl${out.comment.replies.length === 1 ? "y" : "ies"}${out.next_reply_cursor ? `, next_reply_cursor=${out.next_reply_cursor}` : ""}).`;

export function createDriveCommentGetAction(port: DrivePort): ActionDefinition<typeof driveCommentGetInputSchema, DriveCommentGetOutput> {
	return defineAction({
		id: "drive_comment_get", name: "Get Google Drive Comment Thread", domain: "integrations",
		description: "Read a single comment thread on any Google Drive file with its replies paged 100 per call via reply_cursor. Requires domain ('work' or 'angus'), file_id, and comment_id.",
		annotations: READ_ANNOTATIONS, schema: driveCommentGetInputSchema, formatMcp: formatDriveCommentGetMcp,
		run: async (input): Promise<DriveCommentGetOutput> => {
			try {
				const raw = await port.getComment!({ domain: input.domain, fileId: input.file_id, commentId: input.comment_id, includeDeleted: false });
				if (raw.deleted) throw new DriveApiError("Comment deleted", 404, "notFound");
				const replyPage = await port.listReplies!({
					domain: input.domain, fileId: input.file_id, commentId: input.comment_id, pageSize: PAGE_SIZE, pageToken: input.reply_cursor, includeDeleted: false,
				});
				const { reply_count: _rc, replies_truncated: _rt, ...base } = mapComment(raw);
				return {
					domain: input.domain, file_id: input.file_id,
					comment: { ...base, replies: (replyPage.replies ?? []).filter((r) => !r.deleted).map(mapReply) },
					next_reply_cursor: replyPage.nextPageToken ?? null,
				};
			} catch (err) {
				explainDriveCommentError(err, input.domain, input.file_id);
			}
		},
	});
}

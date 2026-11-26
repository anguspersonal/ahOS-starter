import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import { DriveApiError, type DrivePort } from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const domainField = z.enum(DOMAINS).describe("Google Workspace domain ('work' or 'angus')");

const redactSecrets = (msg: string): string => msg.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");

function isInsufficientScopeError(status: number, reason?: string): boolean {
	return status === 403 && (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
}

function explainDriveCommentWriteError(
	err: unknown,
	domain: Domain,
	fileId: string,
	options?: { commentId?: string; onAuthorForbidden?: boolean },
): never {
	if (err !== null && typeof err === "object" && typeof (err as { status?: unknown }).status === "number") {
		const { status, reason, googleStatus } = err as { status: number; reason?: string; googleStatus?: string };
		if (status === 404) {
			throw new DriveApiError(
				`File or comment '${fileId}' not found in the ${domain} account, or not shared with it (HTTP 404).`,
				404,
				reason,
				googleStatus,
			);
		}
		if (isInsufficientScopeError(status, reason)) {
			throw new DriveApiError(
				`Google Drive token for '${domain}' lacks required scope ${DRIVE_SCOPE} (HTTP 403, ${reason}).`,
				403,
				reason,
				googleStatus,
			);
		}
		if (status === 403 && options?.onAuthorForbidden) {
			throw new DriveApiError(
				`Cannot update comment '${options.commentId ?? ""}' on ${domain}:${fileId}: only the author can edit this (HTTP 403).`,
				403,
				reason,
				googleStatus,
			);
		}
		if (err instanceof DriveApiError) {
			throw new DriveApiError(redactSecrets(err.message), err.status, err.reason, err.googleStatus);
		}
	}
	if (err instanceof Error && /Bearer\s+\S+/i.test(err.message)) {
		throw new Error(redactSecrets(err.message));
	}
	throw err;
}

export const driveCommentCreateInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID"),
	content: z.string().min(1).describe("Comment text"),
	quoted_text: z.string().min(1).optional().describe("Optional quoted text snippet from the file to anchor the comment"),
});
export type DriveCommentCreateInput = z.infer<typeof driveCommentCreateInputSchema>;
export interface DriveCommentCreateOutput {
	domain: Domain;
	file_id: string;
	comment_id: string;
	resolved: boolean;
	created_at: string | null;
}

export const formatDriveCommentCreateMcp = (out: DriveCommentCreateOutput): string =>
	`Created comment ${out.comment_id} on ${out.domain}:${out.file_id} (resolved=${out.resolved}).`;

export function createDriveCommentCreateAction(
	port: DrivePort,
): ActionDefinition<typeof driveCommentCreateInputSchema, DriveCommentCreateOutput> {
	return defineAction({
		id: "drive_comment_create",
		name: "Create Google Drive Comment",
		domain: "integrations",
		description:
			"Create a new comment on any Google Drive file (Doc, Sheet, Slides, PDF), optionally anchored to quoted_text. Returns id-only receipt without echoing comment content.",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		schema: driveCommentCreateInputSchema,
		formatMcp: formatDriveCommentCreateMcp,
		run: async (input): Promise<DriveCommentCreateOutput> => {
			try {
				const created = await port.createComment!({
					domain: input.domain,
					fileId: input.file_id,
					content: input.content,
					...(input.quoted_text !== undefined
						? { quotedFileContent: { value: input.quoted_text, mimeType: "text/plain" } }
						: {}),
				});
				return {
					domain: input.domain,
					file_id: input.file_id,
					comment_id: created.id ?? "",
					resolved: Boolean(created.resolved),
					created_at: created.createdTime ?? null,
				};
			} catch (err) {
				explainDriveCommentWriteError(err, input.domain, input.file_id);
			}
		},
	});
}

export const driveCommentReplyInputSchema = z
	.object({
		domain: domainField,
		file_id: z.string().min(1).describe("Google Drive file ID"),
		comment_id: z.string().min(1).describe("Google Drive comment ID"),
		content: z.string().min(1).optional().describe("Reply text (required unless action is provided)"),
		action: z.enum(["resolve", "reopen"]).optional().describe("Optional thread state transition: 'resolve' or 'reopen'"),
	})
	.refine((v) => Boolean(v.content?.trim()) || v.action !== undefined, {
		message: "Either content or action ('resolve' | 'reopen') is required.",
	});
export type DriveCommentReplyInput = z.infer<typeof driveCommentReplyInputSchema>;
export interface DriveCommentReplyOutput {
	domain: Domain;
	file_id: string;
	comment_id: string;
	reply_id: string;
	action: "resolve" | "reopen" | null;
	resolved: boolean;
	created_at: string | null;
}

export const formatDriveCommentReplyMcp = (out: DriveCommentReplyOutput): string =>
	`Replied ${out.reply_id} on comment ${out.comment_id} (${out.domain}:${out.file_id}, resolved=${out.resolved}${out.action ? `, action=${out.action}` : ""}).`;

export function createDriveCommentReplyAction(
	port: DrivePort,
): ActionDefinition<typeof driveCommentReplyInputSchema, DriveCommentReplyOutput> {
	return defineAction({
		id: "drive_comment_reply",
		name: "Reply To Google Drive Comment",
		domain: "integrations",
		description:
			"Reply to, resolve, or reopen a comment thread on any Google Drive file. Requires content, action ('resolve' | 'reopen'), or both. Returns id-only receipt with resolved state.",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		schema: driveCommentReplyInputSchema,
		formatMcp: formatDriveCommentReplyMcp,
		run: async (input): Promise<DriveCommentReplyOutput> => {
			try {
				const reply = await port.createReply!({
					domain: input.domain,
					fileId: input.file_id,
					commentId: input.comment_id,
					...(input.content !== undefined ? { content: input.content } : {}),
					...(input.action !== undefined ? { action: input.action } : {}),
				});
				return {
					domain: input.domain,
					file_id: input.file_id,
					comment_id: input.comment_id,
					reply_id: reply.id ?? "",
					action: input.action ?? null,
					resolved: input.action === "resolve" || reply.action === "resolve",
					created_at: reply.createdTime ?? null,
				};
			} catch (err) {
				explainDriveCommentWriteError(err, input.domain, input.file_id);
			}
		},
	});
}

export const driveCommentUpdateInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID"),
	comment_id: z.string().min(1).describe("Google Drive comment ID"),
	content: z.string().min(1).describe("Updated comment text"),
});
export type DriveCommentUpdateInput = z.infer<typeof driveCommentUpdateInputSchema>;
export interface DriveCommentUpdateOutput {
	domain: Domain;
	file_id: string;
	comment_id: string;
	resolved: boolean;
	modified_at: string | null;
}

export const formatDriveCommentUpdateMcp = (out: DriveCommentUpdateOutput): string =>
	`Updated comment ${out.comment_id} on ${out.domain}:${out.file_id} (resolved=${out.resolved}).`;

export function createDriveCommentUpdateAction(
	port: DrivePort,
): ActionDefinition<typeof driveCommentUpdateInputSchema, DriveCommentUpdateOutput> {
	return defineAction({
		id: "drive_comment_update",
		name: "Update Google Drive Comment",
		domain: "integrations",
		description:
			"Edit the text of an existing Google Drive comment (only the author can edit). Returns id-only receipt without echoing comment content.",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		schema: driveCommentUpdateInputSchema,
		formatMcp: formatDriveCommentUpdateMcp,
		run: async (input): Promise<DriveCommentUpdateOutput> => {
			try {
				const updated = await port.updateComment!({
					domain: input.domain,
					fileId: input.file_id,
					commentId: input.comment_id,
					content: input.content,
				});
				return {
					domain: input.domain,
					file_id: input.file_id,
					comment_id: updated.id ?? input.comment_id,
					resolved: Boolean(updated.resolved),
					modified_at: updated.modifiedTime ?? null,
				};
			} catch (err) {
				explainDriveCommentWriteError(err, input.domain, input.file_id, {
					commentId: input.comment_id,
					onAuthorForbidden: true,
				});
			}
		},
	});
}

export const driveCommentDeleteInputSchema = z.object({
	domain: domainField,
	file_id: z.string().min(1).describe("Google Drive file ID"),
	comment_id: z.string().min(1).describe("Google Drive comment ID"),
});
export type DriveCommentDeleteInput = z.infer<typeof driveCommentDeleteInputSchema>;
export interface DriveCommentDeleteOutput {
	domain: Domain;
	file_id: string;
	comment_id: string;
	deleted: boolean;
}

export const formatDriveCommentDeleteMcp = (out: DriveCommentDeleteOutput): string =>
	out.deleted
		? `Deleted comment ${out.comment_id} on ${out.domain}:${out.file_id}.`
		: `Comment ${out.comment_id} on ${out.domain}:${out.file_id} was already absent (deleted=false).`;

export function createDriveCommentDeleteAction(
	port: DrivePort,
): ActionDefinition<typeof driveCommentDeleteInputSchema, DriveCommentDeleteOutput> {
	return defineAction({
		id: "drive_comment_delete",
		name: "Delete Google Drive Comment",
		domain: "integrations",
		description:
			"Permanently delete a comment on a Google Drive file. Parks for owner approval on agent calls; returns { deleted: false } if already absent (404).",
		needsApproval: true,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		schema: driveCommentDeleteInputSchema,
		formatMcp: formatDriveCommentDeleteMcp,
		run: async (input): Promise<DriveCommentDeleteOutput> => {
			try {
				await port.deleteComment!({
					domain: input.domain,
					fileId: input.file_id,
					commentId: input.comment_id,
				});
				return {
					domain: input.domain,
					file_id: input.file_id,
					comment_id: input.comment_id,
					deleted: true,
				};
			} catch (err) {
				if (err !== null && typeof err === "object" && (err as { status?: unknown }).status === 404) {
					return {
						domain: input.domain,
						file_id: input.file_id,
						comment_id: input.comment_id,
						deleted: false,
					};
				}
				explainDriveCommentWriteError(err, input.domain, input.file_id);
			}
		},
	});
}

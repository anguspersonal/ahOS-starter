import { z } from "zod";
import { domainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import type {
	DriveComment,
	DriveCommentReply,
	DrivePort,
} from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { defineAction } from "../defineAction.js";
import {
	createDriveCommentListAction,
	formatDriveCommentListMcp,
	type DriveCommentListOutput,
} from "../drive/commentRead.js";
import type { ActionDefinition } from "../types.js";

const MISSING_DOMAIN_ERROR =
	"`domain` is required to send \u2014 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

export const docsCommentsInput = {
	document_id: z.string().min(1).describe("The Google Doc ID."),
	domain: domainInput,
	account: googleAccountInput,
	action: z
		.enum(["list", "create", "reply"])
		.describe(
			"Action to perform: 'list' (list comments and replies), 'create' (create a new comment anchored to quoted text), or 'reply' (reply to an existing comment).",
		),
	content: z
		.string()
		.optional()
		.describe(
			"Comment or reply content text. Required for 'create' and 'reply'.",
		),
	quoted_text: z
		.string()
		.optional()
		.describe(
			"Text snippet from the document to anchor the comment to. Used with action='create'.",
		),
	comment_id: z
		.string()
		.optional()
		.describe(
			"ID of the parent comment when action='reply'. Required for 'reply'.",
		),
	include_resolved: z
		.boolean()
		.optional()
		.describe(
			"Whether to include resolved comments in list (default false).",
		),
	page_size: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max matching comments to return when listing (1-100, default 20)."),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe("Pagination cursor (next_cursor) from a previous action='list' call."),
};

export const docsCommentsInputSchema = z.object(docsCommentsInput);
export const docsCommentsSchema = docsCommentsInputSchema;
export type DocsCommentsInput = z.infer<typeof docsCommentsInputSchema>;

export type DocsCommentsOutput =
	| DriveCommentListOutput
	| {
			action: "create";
			documentId: string;
			quotedText?: string;
			comment: DriveComment;
	  }
	| {
			action: "reply";
			documentId: string;
			commentId: string;
			reply: DriveCommentReply;
	  };

export function formatDocsCommentsMcp(out: DocsCommentsOutput): string {
	// A list is drive_comment_list's output unchanged, so it has no `action` key.
	if (!("action" in out)) return formatDriveCommentListMcp(out);

	if (out.action === "create") {
		const author = out.comment.author?.displayName ?? out.comment.author?.emailAddress ?? "You";
		return [
			`Created comment ${out.comment.id} on document ${out.documentId}:`,
			`Author:  ${author}`,
			`Created: ${out.comment.createdTime ?? ""}`,
			out.quotedText ? `Quoted:  "${out.quotedText}"` : "Quoted:  (none / unanchored)",
			`Content: "${out.comment.content}"`,
		].join("\n");
	}

	const author = out.reply.author?.displayName ?? out.reply.author?.emailAddress ?? "You";
	return [
		`Created reply ${out.reply.id} on comment ${out.commentId}:`,
		`Author:  ${author}`,
		`Created: ${out.reply.createdTime ?? ""}`,
		`Content: "${out.reply.content}"`,
	].join("\n");
}

export function createDocsCommentsAction(
	port: DrivePort,
): ActionDefinition<typeof docsCommentsInputSchema, DocsCommentsOutput> {
	const listAction = createDriveCommentListAction(port);

	return defineAction({
		id: "docs_comments",
		domain: "integrations",
		description:
			"List comments and replies, or create a comment anchored to quoted text on a Google Doc. Full notes: docs/guides/tools/docs_comments.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: docsCommentsInputSchema,
		formatMcp: formatDocsCommentsMcp,
		async run(args, ctx): Promise<DocsCommentsOutput> {
			const domain = reconcileDomain(args.domain, args.account, "account");
			if (!domain) {
				throw new Error(MISSING_DOMAIN_ERROR);
			}

			if (args.action === "list") {
				// Nested dispatch (ADR-104 section 1): drive_comment_list pages and filters, and writes its own ledger row.
				return executeAction(
					listAction,
					{
						domain,
						file_id: args.document_id,
						include_resolved: args.include_resolved,
						limit: args.page_size,
						cursor: args.cursor,
					},
					{ context: { caller: "internal", userId: ctx.userId } },
				);
			}

			if (args.action === "create") {
				if (!args.content || !args.content.trim()) {
					throw new Error("content is required when action='create'.");
				}
				const comment = await port.createComment!({
					domain,
					fileId: args.document_id,
					content: args.content,
					...(args.quoted_text
						? { quotedFileContent: { value: args.quoted_text, mimeType: "text/plain" } }
						: {}),
				});
				return {
					action: "create",
					documentId: args.document_id,
					quotedText: args.quoted_text,
					comment,
				};
			}

			if (args.action === "reply") {
				if (!args.comment_id) {
					throw new Error(
						"comment_id is required when action='reply'. Pass the ID of the comment to reply to.",
					);
				}
				if (!args.content || !args.content.trim()) {
					throw new Error("content is required when action='reply'.");
				}
				const reply = await port.createReply!({
					domain,
					fileId: args.document_id,
					commentId: args.comment_id,
					content: args.content,
				});
				return {
					action: "reply",
					documentId: args.document_id,
					commentId: args.comment_id,
					reply,
				};
			}

			throw new Error(`Unknown action '${args.action}'. Must be 'list', 'create', or 'reply'.`);
		},
	});
}

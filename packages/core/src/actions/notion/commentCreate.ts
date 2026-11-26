import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type { NotionApiError, NotionCreateCommentParams, NotionPort } from "../../ports/notion.js";
import { normalizeNotionId } from "./pageGet.js";

import { NOTION_TEXT_LIMIT, richTextRuns } from "./blocks.js";

export { NOTION_TEXT_LIMIT, richTextRuns };

const DOMAIN_PROVIDER: Record<Domain, string> = {
	work: "notion_work",
	angus: "notion_personal",
};

function isNotionNotFound(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.name === "NotionApiError" &&
		(err as NotionApiError).status === 404
	);
}

function crossWorkspaceHint(domain: Domain): string {
	const other = DOMAINS.find((d) => d !== domain);
	return `Not found in the '${domain}' workspace (provider '${DOMAIN_PROVIDER[domain]}'). The two workspaces have disjoint page access — if this page lives in the other one, retry with domain='${other}'.`;
}

export const notionCommentCreateInputSchema = z.object({
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which workspace: 'work' (the Work workspace) or 'angus' (the personal one). No default — the workspaces are separate Notion integrations with disjoint page access (ADR-054 §9).",
		),
	page_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The page to comment on: a 32-hex Notion id or URL. Starts a new top-level comment thread on the page. Exactly one of page_id / block_id / discussion_id.",
		),
	block_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The block to attach a comment to: a 32-hex Notion id or URL. Starts a new comment thread on that block. Exactly one of page_id / block_id / discussion_id.",
		),
	discussion_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The discussion thread to reply to: a 32-hex Notion discussion id. Adds a reply to that existing thread. Exactly one of page_id / block_id / discussion_id.",
		),
	text: z
		.string()
		.min(1)
		.optional()
		.describe("The comment body text. Converted into Notion rich text runs. Provide either text or rich_text."),
	rich_text: z
		.array(z.record(z.string(), z.unknown()))
		.optional()
		.describe("Raw Notion rich_text array if providing formatted rich text directly. Provide either text or rich_text."),
});

export type NotionCommentCreateInput = z.infer<typeof notionCommentCreateInputSchema>;

export const notionCommentCreateOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	id: z.string(),
	discussionId: z.string().optional(),
	createdTime: z.string().optional(),
});

export type NotionCommentCreateOutput = z.infer<typeof notionCommentCreateOutputSchema>;

export function formatNotionCommentCreateMcp(result: NotionCommentCreateOutput): string {
	const lines = [
		`Created comment ${result.id} in the '${result.domain}' workspace.`,
		`Discussion thread: ${result.discussionId ?? "(unknown)"}`,
		`Created at: ${result.createdTime ?? new Date().toISOString()}`,
	];
	return lines.join("\n");
}

export function createNotionCommentCreateAction(
	port: NotionPort,
): ActionDefinition<typeof notionCommentCreateInputSchema, NotionCommentCreateOutput> {
	return defineAction({
		id: "notion_comment_create",
		name: "notion_comment_create",
		description:
			"Create a comment on a Notion page or block, or reply to an existing discussion thread. " +
			"In Notion, comments can either start a new top-level thread on a page or block " +
			"(via parent: { page_id } or parent: { block_id }), or reply to an existing " +
			"thread (via discussion_id). Exactly one destination must be specified.",
		domain: "integrations",
		schema: notionCommentCreateInputSchema,
		outputSchema: notionCommentCreateOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp(result) {
			return formatNotionCommentCreateMcp(result);
		},
		async run(input: NotionCommentCreateInput, _context: ActionContext): Promise<NotionCommentCreateOutput> {
			if (!input.domain) {
				throw new Error(
					"`domain` is required to create a Notion comment — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}

			const targets = [
				input.page_id ? { type: "page_id" as const, id: input.page_id } : null,
				input.block_id ? { type: "block_id" as const, id: input.block_id } : null,
				input.discussion_id ? { type: "discussion_id" as const, id: input.discussion_id } : null,
			].filter((t): t is NonNullable<typeof t> => t !== null);

			if (targets.length !== 1) {
				throw new Error(
					"Exactly one of `page_id` (new page comment), `block_id` (new block comment), or `discussion_id` (reply to existing thread) is required.",
				);
			}

			const text = input.text?.trim();
			if (!text && (!input.rich_text || input.rich_text.length === 0)) {
				throw new Error(
					"Comment content is required: pass `text` (plain string) or `rich_text` (Notion rich text array).",
				);
			}

			const richText =
				input.rich_text && input.rich_text.length > 0
					? input.rich_text
					: richTextRuns(text!);

			const target = targets[0];
			const targetId = normalizeNotionId(target.id);
			const domain = input.domain;

			const commentInput: NotionCreateCommentParams = {
				workspace: domain,
				rich_text: richText,
			};

			if (target.type === "discussion_id") {
				commentInput.discussion_id = targetId;
			} else if (target.type === "page_id") {
				commentInput.parent = { page_id: targetId };
			} else {
				commentInput.parent = { block_id: targetId };
			}

			let comment: Awaited<ReturnType<typeof port.createComment>>;
			try {
				comment = await port.createComment(commentInput);
			} catch (err) {
				if (isNotionNotFound(err)) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
				}
				throw err;
			}

			return {
				domain,
				id: comment.id,
				discussionId: comment.discussion_id,
				createdTime: comment.created_time,
			};
		},
	});
}

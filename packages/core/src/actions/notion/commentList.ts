import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type { NotionApiError, NotionPort } from "../../ports/notion.js";
import { normalizeNotionId } from "./pageGet.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

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

export const notionCommentListInputSchema = z.object({
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which workspace: 'work' (the Work workspace) or 'angus' (the personal one). No default — the workspaces are separate Notion integrations with disjoint page access (ADR-054 §9).",
		),
	block_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The page or block whose comments to list: a 32-hex Notion id (dashed or undashed) or a Notion URL. Pages in Notion are blocks, so a page id lists page-level comments.",
		),
	page_id: z
		.string()
		.min(1)
		.optional()
		.describe("Alias for block_id. The page whose comments to list."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_LIMIT)
		.optional()
		.describe(`Number of comments to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe("The next_cursor from a previous call, to fetch the following page of comments."),
});

export type NotionCommentListInput = z.infer<typeof notionCommentListInputSchema>;

export const notionCommentItemSchema = z.object({
	id: z.string(),
	discussionId: z.string().optional(),
	createdTime: z.string().optional(),
	authorId: z.string().optional(),
	text: z.string(),
});

export type NotionCommentItem = z.infer<typeof notionCommentItemSchema>;

export const notionCommentListOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	id: z.string(),
	comments: z.array(notionCommentItemSchema),
	hasMore: z.boolean(),
	nextCursor: z.string().nullable().optional(),
});

export type NotionCommentListOutput = z.infer<typeof notionCommentListOutputSchema>;

export function formatNotionCommentListMcp(result: NotionCommentListOutput): string {
	if (result.comments.length === 0) {
		const lines = [`0 comments on ${result.id} in the '${result.domain}' workspace.`];
		if (result.hasMore && result.nextCursor) {
			lines.push(`More comments exist. Pass cursor '${result.nextCursor}' to fetch the next page.`);
		}
		return lines.join("\n");
	}

	const lines = [`Comments on ${result.id} (${result.domain}), ${result.comments.length} listed:`];
	for (const c of result.comments) {
		const thread = c.discussionId ? ` (thread: ${c.discussionId})` : "";
		lines.push(`• [${c.id}]${thread} by ${c.authorId ?? "unknown"} at ${c.createdTime ?? ""}:`);
		lines.push(`  ${c.text || "(empty comment)"}`);
	}

	if (result.hasMore && result.nextCursor) {
		lines.push(`More comments exist. Pass cursor '${result.nextCursor}' to fetch the next page.`);
	}

	return lines.join("\n");
}

export function createNotionCommentListAction(
	port: NotionPort,
): ActionDefinition<typeof notionCommentListInputSchema, NotionCommentListOutput> {
	return defineAction({
		id: "notion_comment_list",
		name: "notion_comment_list",
		description:
			"List comments on a Notion page or block: top-level comments and open discussion threads. " +
			"In Notion, pages are blocks, so passing a page_id or block_id lists comments attached to that object.",
		domain: "integrations",
		schema: notionCommentListInputSchema,
		outputSchema: notionCommentListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp(result) {
			return formatNotionCommentListMcp(result);
		},
		async run(input: NotionCommentListInput, _context: ActionContext): Promise<NotionCommentListOutput> {
			if (!input.domain) {
				throw new Error(
					"`domain` is required to list Notion comments — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}

			const rawId = input.block_id ?? input.page_id;
			if (!rawId) {
				throw new Error(
					"`block_id` (or `page_id`) is required to list Notion comments: a 32-hex Notion id or URL.",
				);
			}

			const id = normalizeNotionId(rawId);
			const domain = input.domain;

			let result: Awaited<ReturnType<typeof port.listComments>>;
			try {
				result = await port.listComments({
					workspace: domain,
					blockId: id,
					pageSize: input.limit ?? DEFAULT_LIMIT,
					cursor: input.cursor,
				});
			} catch (err) {
				if (isNotionNotFound(err)) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
				}
				throw err;
			}

			const comments: NotionCommentItem[] = (result.results ?? []).map((c) => {
				const text = (c.rich_text ?? [])
					.map((r) => r.plain_text ?? r.text?.content ?? "")
					.join("");
				return {
					id: c.id,
					discussionId: c.discussion_id,
					createdTime: c.created_time,
					authorId: c.created_by?.id,
					text,
				};
			});

			return {
				domain,
				id,
				comments,
				hasMore: result.has_more,
				nextCursor: result.next_cursor ?? null,
			};
		},
	});
}

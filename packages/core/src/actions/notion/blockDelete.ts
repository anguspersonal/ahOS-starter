import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type { NotionApiError, NotionBlockItem, NotionPort } from "../../ports/notion.js";
import { normalizeNotionId } from "./pageGet.js";

const MAX_PARENT_WALK = 12;

const DOMAIN_PROVIDER: Record<Domain, string> = {
	work: "notion_work",
	angus: "notion_personal",
};

export function sameNotionId(a: string, b: string): boolean {
	return a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();
}

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

export const notionBlockDeleteInputSchema = z.object({
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
			"The block to delete: a 32-hex Notion id (dashed or undashed) or a Notion URL. Read block ids from notion_page_get.",
		),
});

export type NotionBlockDeleteInput = z.infer<typeof notionBlockDeleteInputSchema>;

export const notionBlockDeleteOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	blockId: z.string(),
	pageId: z.string(),
});

export type NotionBlockDeleteOutput = z.infer<typeof notionBlockDeleteOutputSchema>;

export function formatNotionBlockDeleteMcp(result: NotionBlockDeleteOutput): string {
	return `Deleted block ${result.blockId} from page ${result.pageId} (domain='${result.domain}'). Notion moved it to that page's trash, so it can be restored from the Notion UI.`;
}

export async function resolveParentPageId(
	blockId: string,
	port: NotionPort,
	domain: Domain,
	maxHops: number = MAX_PARENT_WALK,
): Promise<string | undefined> {
	let currentId = blockId;
	for (let hop = 0; hop < maxHops; hop++) {
		let block: NotionBlockItem;
		try {
			block = await port.retrieveBlock({ workspace: domain, blockId: currentId });
		} catch (err) {
			if (isNotionNotFound(err)) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
			}
			throw err;
		}

		const parent = block.parent;
		if (!parent) return undefined;
		if (parent.type === "page_id" && parent.page_id) {
			return parent.page_id;
		}
		if (parent.type === "block_id" && parent.block_id) {
			currentId = parent.block_id;
			continue;
		}
		// A database_id, workspace or other parent type is not a page; stop.
		return undefined;
	}
	return undefined;
}

export function createNotionBlockDeleteAction(
	port: NotionPort,
): ActionDefinition<typeof notionBlockDeleteInputSchema, NotionBlockDeleteOutput> {
	return defineAction({
		id: "notion_block_delete",
		name: "notion_block_delete",
		description:
			"Delete a block from a Notion page by block_id. The block is moved to the page's trash, " +
			"so it can be restored from the Notion UI. Refuses blocks belonging to the State Doc " +
			"(ADR-053 one-writer rule) by walking up to the containing page first.",
		domain: "integrations",
		schema: notionBlockDeleteInputSchema,
		outputSchema: notionBlockDeleteOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp(result) {
			return formatNotionBlockDeleteMcp(result);
		},
		async run(input: NotionBlockDeleteInput, _context: ActionContext): Promise<NotionBlockDeleteOutput> {
			if (!input.domain) {
				throw new Error(
					"`domain` is required to delete a Notion block — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}

			if (!input.block_id) {
				throw new Error(
					"`block_id` is required — the block to delete. Read block ids from notion_page_get. Nothing was deleted.",
				);
			}

			const domain = input.domain;
			const blockId = normalizeNotionId(input.block_id);

			const pageId = await resolveParentPageId(blockId, port, domain);
			if (!pageId) {
				throw new Error(
					`Could not resolve which page block ${blockId} belongs to, so the State Doc guard (ADR-053) cannot be applied. Nothing was deleted. This happens when the block hangs off a database, a data source or the workspace root rather than a page. Delete it in the Notion UI if that is really what you want.`,
				);
			}

			if (port.getStateDocPageId) {
				const stateDocId = await port.getStateDocPageId(domain);
				if (stateDocId && sameNotionId(stateDocId, pageId)) {
					throw new Error(
						`This is the '${domain}' State Doc. Its sections are edited only through state_doc_update (ADR-053 one-writer rule) — use that tool, which addresses sections by exact heading and stamps 'Last updated' itself.`,
					);
				}
			}

			try {
				await port.deleteBlock({ workspace: domain, blockId });
			} catch (err) {
				if (isNotionNotFound(err)) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
				}
				throw err;
			}

			return {
				domain,
				blockId,
				pageId,
			};
		},
	});
}

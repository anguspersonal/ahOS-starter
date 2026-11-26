import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { NotionApiError, NotionBlockItem, NotionPageResponse, NotionPort } from "../../ports/notion.js";

const DEFAULT_MAX_BLOCKS = 300;
const MAX_BLOCKS_CAP = 1000;

const DOMAIN_PROVIDER: Record<Domain, string> = {
	work: "notion_work",
	angus: "notion_personal",
};

export const notionPageGetInputSchema = z.object({
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which workspace to read from: 'work' (the Work workspace) or 'angus' (the personal one). No default — the workspaces are separate Notion integrations with disjoint page access (ADR-054 §9), and a page that 404s in one may live in the other.",
		),
	page_id: z
		.string()
		.min(1)
		.describe(
			"The page to read: a 32-hex Notion id (dashed or not) or a full notion.so / app.notion.com URL. A BLOCK id is also accepted — pass a has_children block's id back in to list its nested children.",
		),
	max_blocks: z
		.number()
		.int()
		.min(1)
		.max(MAX_BLOCKS_CAP)
		.optional()
		.describe(
			`Max blocks to return in one call (default ${DEFAULT_MAX_BLOCKS}, max ${MAX_BLOCKS_CAP}). Further blocks come back via next_cursor.`,
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe("The next_cursor from a previous notion_page_get call, to fetch the following page of blocks."),
});

export type NotionPageGetInput = z.infer<typeof notionPageGetInputSchema>;

export const notionPageGetOutputSchema = z.object({
	id: z.string(),
	domain: z.enum(DOMAINS),
	hasPageEnvelope: z.boolean(),
	page: z.custom<NotionPageResponse>().optional(),
	blocks: z.array(z.custom<NotionBlockItem>()),
	totalBlocks: z.number(),
	has_more: z.boolean(),
	next_cursor: z.string().nullable(),
});

export type NotionPageGetOutput = z.infer<typeof notionPageGetOutputSchema>;

export function normalizeNotionId(input: string): string {
	const segment = input.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() ?? "";
	const runs = segment.replace(/-/g, "").match(/[0-9a-f]{32,}/gi);
	if (!runs) {
		throw new Error(
			`Could not find a Notion id in '${input}' — pass a 32-hex page/block id (dashed or not) or a full Notion URL.`,
		);
	}
	const run = runs[runs.length - 1];
	const id = run.slice(run.length - 32).toLowerCase();
	return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function propertyPlain(value: Record<string, unknown>): string {
	const type = value.type as string | undefined;
	const payload = type ? value[type] : undefined;
	if (payload === null || payload === undefined) return "(empty)";
	if (type === "title" || type === "rich_text") {
		const runs = payload as { plain_text?: string }[];
		return runs.map((r) => r.plain_text ?? "").join("") || "(empty)";
	}
	if (type === "select" || type === "status") {
		return (payload as { name?: string }).name ?? "(empty)";
	}
	if (type === "multi_select") {
		return (payload as { name?: string }[]).map((o) => o.name ?? "").join(", ") || "(empty)";
	}
	if (type === "date") {
		const d = payload as { start?: string; end?: string };
		return d.start ? `${d.start}${d.end ? ` → ${d.end}` : ""}` : "(empty)";
	}
	if (type === "checkbox" || type === "number") return String(payload);
	if (type === "url" || type === "email" || type === "phone_number") return String(payload);
	if (type === "people" || type === "created_by" || type === "last_edited_by") {
		const list = Array.isArray(payload) ? (payload as { id?: string; name?: string }[]) : [payload as { id?: string; name?: string }];
		return list.map((u) => (u.name ? `${u.name} (${u.id ?? "?"})` : u.id ?? "?")).join(", ") || "(empty)";
	}
	if (type === "relation") {
		const rel = payload as { id?: string }[];
		return rel.length ? `${rel.length} related: ${rel.map((r) => r.id ?? "?").join(", ")}` : "(empty)";
	}
	if (type === "formula" || type === "rollup") {
		const inner = payload as Record<string, unknown>;
		const innerType = inner.type as string | undefined;
		if (innerType === "array") {
			const items = Array.isArray(inner.array) ? (inner.array as Record<string, unknown>[]) : [];
			return items.length ? items.map((item) => propertyPlain(item)).join(", ") : "(empty)";
		}
		if (innerType === "string" || innerType === "number" || innerType === "boolean") {
			const v = inner[innerType];
			return v === null || v === undefined ? "(empty)" : String(v);
		}
		if (innerType && innerType in inner) return propertyPlain({ type: innerType, [innerType]: inner[innerType] });
	}
	if (type === "created_time" || type === "last_edited_time") return String(payload);
	const json = JSON.stringify(payload);
	return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

type BlockRichTextItem = {
	plain_text?: string;
	href?: string | null;
	text?: {
		content?: string;
		link?: { url?: string } | null;
	};
	annotations?: {
		bold?: boolean;
		italic?: boolean;
		strikethrough?: boolean;
		code?: boolean;
	};
};

function sameRichTextStyle(a: BlockRichTextItem, b: BlockRichTextItem): boolean {
	const urlA = a.text?.link?.url ?? a.href ?? undefined;
	const urlB = b.text?.link?.url ?? b.href ?? undefined;
	if (urlA !== urlB) return false;
	const annA = a.annotations;
	const annB = b.annotations;
	return (
		Boolean(annA?.bold) === Boolean(annB?.bold) &&
		Boolean(annA?.italic) === Boolean(annB?.italic) &&
		Boolean(annA?.strikethrough) === Boolean(annB?.strikethrough) &&
		Boolean(annA?.code) === Boolean(annB?.code)
	);
}

function coalesceRichTextRuns(runs: BlockRichTextItem[]): BlockRichTextItem[] {
	const merged: BlockRichTextItem[] = [];
	for (const run of runs) {
		const raw = run.plain_text ?? run.text?.content ?? "";
		if (!raw) continue;
		const prev = merged[merged.length - 1];
		if (prev && sameRichTextStyle(prev, run)) {
			const prevRaw = prev.plain_text ?? prev.text?.content ?? "";
			const combined = prevRaw + raw;
			prev.plain_text = combined;
			if (prev.text) {
				prev.text = { ...prev.text, content: combined };
			}
		} else {
			merged.push({
				...run,
				plain_text: raw,
				...(run.text ? { text: { ...run.text, content: raw } } : {}),
				...(run.annotations ? { annotations: { ...run.annotations } } : {}),
			});
		}
	}
	return merged;
}

function formatRichTextItem(item: BlockRichTextItem): string {
	const raw = item.plain_text ?? item.text?.content ?? "";
	if (!raw) return "";

	const ann = item.annotations;
	const hasAnnotations = Boolean(ann?.code || ann?.strikethrough || ann?.italic || ann?.bold);
	let formatted = raw;

	if (hasAnnotations) {
		const match = /^([ \t]*)(.*?)([ \t]*)$/s.exec(raw);
		const leading = match?.[1] ?? "";
		const core = match?.[2] ?? "";
		const trailing = match?.[3] ?? "";

		if (core.length > 0) {
			let inner = core;
			if (ann?.code) inner = `\`${inner}\``;
			if (ann?.strikethrough) inner = `~~${inner}~~`;
			if (ann?.italic) inner = `*${inner}*`;
			if (ann?.bold) inner = `**${inner}**`;
			formatted = `${leading}${inner}${trailing}`;
		}
	}

	const url = item.text?.link?.url ?? item.href ?? undefined;
	if (url) {
		return `[${formatted}](${url})`;
	}
	return formatted;
}

export function blockPlainText(block: NotionBlockItem): string {
	const payload = block[block.type] as { rich_text?: BlockRichTextItem[] } | undefined;
	const runs = payload?.rich_text ?? [];
	return coalesceRichTextRuns(runs).map(formatRichTextItem).join("");
}

function renderBlock(block: NotionBlockItem, index: number): string {
	const flags = [
		block.has_children ? "▸has_children" : "",
		block.archived ? "archived" : "",
	]
		.filter(Boolean)
		.join(", ");
	const text = blockPlainText(block);
	return `${index + 1}. [${block.id}] ${block.type}${flags ? ` (${flags})` : ""}${text ? `: ${text}` : ""}`;
}

function renderPageMeta(page: NotionPageResponse): string[] {
	const lines: string[] = [];
	if (page.archived) lines.push("ARCHIVED: true");
	if (page.last_edited_time) lines.push(`last_edited: ${page.last_edited_time}`);
	const properties = Object.entries(page.properties ?? {});
	if (properties.length > 0) {
		lines.push("Properties:");
		for (const [name, value] of properties) {
			lines.push(`  ${name}: ${propertyPlain(value as Record<string, unknown>)}`);
		}
	}
	return lines;
}

function isNotionNotFound(err: unknown): boolean {
	return err instanceof Error && err.name === "NotionApiError" && (err as NotionApiError).status === 404;
}

function isNotPageEnvelope(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (isNotionNotFound(err)) return true;
	return err.name === "NotionApiError" && (err as NotionApiError).status === 400 && /not a page|is a database/i.test(err.message);
}

function crossWorkspaceHint(domain: Domain): string {
	const other = DOMAINS.find((d) => d !== domain);
	return `Not found in the '${domain}' workspace (provider '${DOMAIN_PROVIDER[domain]}'). The two workspaces have disjoint page access — if this page lives in the other one, retry with domain='${other}'.`;
}

export function formatNotionPageGetMcp(result: NotionPageGetOutput): string {
	const metaLines = result.hasPageEnvelope && result.page
		? renderPageMeta(result.page)
		: ["(no page envelope — this id is a block or database container, listing its children)"];

	const lines = [
		`Notion read: ${result.id} (domain='${result.domain}')`,
		...metaLines,
		`Blocks (${result.totalBlocks}):`,
		...result.blocks.map(renderBlock),
	];
	if (result.has_more) {
		lines.push(
			result.next_cursor
				? `… ${result.blocks.length} blocks shown; more follow, pass cursor '${result.next_cursor}' to notion_page_get to read the next page of blocks.`
				: `… ${result.blocks.length} blocks shown; more follow, pass cursor to notion_page_get to read the next page of blocks.`,
		);
	}
	if (!result.hasPageEnvelope && result.totalBlocks === 0) {
		lines.push(
			"Nothing listed because this id has no child BLOCKS. If it is a database, its rows are not block children and never appear here — this is not evidence the database is empty.",
		);
	}
	lines.push(
		"Block ids are the handles for notion_page_update (op='update_block', or append's `after`); pass a ▸has_children block's id back into notion_page_get to list its children.",
	);

	return lines.join("\n");
}

export function createNotionPageGetAction(
	port: NotionPort,
): ActionDefinition<typeof notionPageGetInputSchema, NotionPageGetOutput> {
	return defineAction({
		id: "notion_page_get",
		name: "notion_page_get",
		description:
			"Read any Notion page or block container: its properties, then every child block with id, type, " +
			"and Markdown-formatted text (preserving inline links and rich-text annotations). `domain` ('work' or 'angus') is REQUIRED, no default -- the workspaces are " +
			"separate integrations with disjoint page access. Read-only. Full notes: " +
			"docs/guides/tools/notion_page_get.md",
		domain: "integrations",
		schema: notionPageGetInputSchema,
		outputSchema: notionPageGetOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp(result) {
			return formatNotionPageGetMcp(result);
		},
		async run(input: NotionPageGetInput, _context: ActionContext): Promise<NotionPageGetOutput> {
			if (!input.domain) {
				throw new Error(
					"`domain` is required to read a Notion page — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}
			if (!input.page_id) {
				throw new Error("`page_id` is required — a Notion page/block id or URL.");
			}

			await port.resolveToken(input.domain);
			const id = normalizeNotionId(input.page_id);
			const maxBlocks = Math.min(MAX_BLOCKS_CAP, Math.max(1, input.max_blocks ?? DEFAULT_MAX_BLOCKS));

			let blocks: NotionBlockItem[];
			let hasMore = false;
			let nextCursor: string | null = null;
			try {
				const response = await port.listBlockChildren({
					workspace: input.domain,
					blockId: id,
					maxBlocks,
					...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
				});
				if (response.results.length > maxBlocks) {
					blocks = response.results.slice(0, maxBlocks);
					hasMore = true;
					nextCursor = response.next_cursor ?? null;
				} else {
					blocks = response.results;
					hasMore = Boolean(response.has_more);
					nextCursor = response.next_cursor ?? null;
				}
			} catch (err: unknown) {
				if (isNotionNotFound(err)) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`${message}\n${crossWorkspaceHint(input.domain)}`);
				}
				throw err;
			}

			let page: NotionPageResponse | undefined;
			let hasPageEnvelope = true;
			try {
				page = await port.retrievePage({ workspace: input.domain, pageId: id });
			} catch (err: unknown) {
				if (!isNotPageEnvelope(err)) throw err;
				hasPageEnvelope = false;
			}

			return {
				id,
				domain: input.domain,
				hasPageEnvelope,
				page,
				blocks,
				totalBlocks: blocks.length,
				has_more: hasMore,
				next_cursor: nextCursor,
			};
		},
	});
}

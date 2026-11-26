import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type { NotionApiError, NotionPort } from "../../ports/notion.js";
import { normalizeNotionId } from "./pageGet.js";
import { markdownToBlocks, richTextRuns } from "./blocks.js";

// The write half of the generic Notion page surface (#818). Three operations behind
// one `op`, the state_doc_update idiom: append blocks, rewrite ONE block in place
// (the RAG-status-line primitive — a whole-page rewrite would lose hand-edits made in
// the Notion UI between sessions), and patch page properties.
//
// #818 excluded a delete op on the reasoning that it was destructive and unrequested.
// #1058 revisits the first half of that, not the second: Notion's public API has no
// permanent delete at all. `archived: true` is its TRASH flag — recoverable from the
// Notion UI, and reversed by `archived: false` through this same op. So archive/restore
// is not the destructive operation #818 declined; it is an ordinary reversible edit,
// and it stays `destructiveHint: false` without parking at the owner approval gate
// (reserved for outward or genuinely permanent operations like drive_delete). There is
// still no permanent delete here, because Notion does not offer one.

export const updateNotionPageInput = {
	// `.optional()` at the zod layer, required by requireDomain/requireOp in the
	// handler (the updateStateDoc convention): an omitted value gets a teaching error
	// naming the accepted ones, not the SDK's bare "Required".
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which workspace to write to: 'work' (the Work workspace) or 'angus' (the personal one). No default — each domain resolves its own token, and a destination that defaults silently is one that will one day be wrong (ADR-054 §9; #820).",
		),
	op: z
		.enum(["append", "update_block", "update_properties"])
		.optional()
		.describe(
			"Required. append: add blocks to the end of a page (or after `after`). update_block: replace ONE block's text in place, keeping its type. update_properties: patch page properties with raw Notion REST value shapes.",
		),
	page_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"append / update_properties: the target page — a 32-hex id (dashed or not) or a full Notion URL. append also accepts a block id as the parent.",
		),
	after: z
		.string()
		.min(1)
		.optional()
		.describe(
			"append: place the new blocks immediately after this sibling block id (from notion_page_get) instead of at the end.",
		),
	body: z
		.string()
		.optional()
		.describe(
			"append: the content, one block per line. '- ' / '* ' become bullets, '- [ ]' / '- [x]' to-dos, '1. ' numbered items, '> ' quotes, '#'/'##'/'###' headings; anything else is a paragraph. Inline markdown ([label](url), **bold**, *italic*, `code`, ~~strikethrough~~) is parsed into Notion rich_text runs.",
		),
	block_id: z
		.string()
		.min(1)
		.optional()
		.describe("update_block: the block to rewrite. Get ids from notion_page_get."),
	block_type: z
		.string()
		.min(1)
		.optional()
		.describe(
			"update_block: the block's type exactly as notion_page_get reported it (paragraph, bulleted_list_item, heading_2, to_do, …). Required because Notion's block PATCH is keyed by type.",
		),
	text: z
		.string()
		.optional()
		.describe(
			"update_block: the block's new text (supports inline markdown links [label](url) and **bold**, *italic*, `code`, ~~strikethrough~~). Replaces THAT block's rich text wholesale; neighbouring blocks are untouched.",
		),
	checked: z
		.boolean()
		.optional()
		.describe("update_block on a to_do block: set the checkbox state in the same call."),
	properties: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'update_properties: keyed by property NAME with real Notion REST value shapes — {"select": {"name": "Green"}}, {"date": {"start": "2026-08-23"}}, {"checkbox": true} — not the claude.ai connector\'s __YES__ / "date:X:start" conventions.',
		),
	archived: z
		.boolean()
		.optional()
		.describe(
			"update_properties: true moves the page to Notion's TRASH, false restores it. Recoverable either way — Notion's API has no permanent delete — so there is no confirm gate. Properties are untouched by both. May be combined with `properties` in one call.",
		),
	icon: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'update_properties: the page icon, in Notion\'s raw shape — {"emoji": "📓"} or {"external": {"url": "https://…"}}. Same raw-REST convention as `properties`.',
		),
} as const;

export const notionPageUpdateInput = updateNotionPageInput;
export const notionPageUpdateInputSchema = z.object(updateNotionPageInput);
type UpdateNotionPageArgs = z.infer<typeof notionPageUpdateInputSchema>;
export type UpdateNotionPageCall = Partial<UpdateNotionPageArgs>;
export type NotionPageUpdateCall = UpdateNotionPageCall;
export type NotionPageUpdateInput = UpdateNotionPageArgs;

type Op = NonNullable<UpdateNotionPageArgs["op"]>;

const UNIVERSAL_ARGS = ["domain", "op"] as const;
const ALLOWED_ARGS: Record<Op, readonly string[]> = {
	append: ["page_id", "after", "body"],
	update_block: ["block_id", "block_type", "text", "checked"],
	update_properties: ["page_id", "properties", "archived", "icon"],
};

function requireOp(args: UpdateNotionPageCall): Op {
	if (!args.op) {
		throw new Error(
			"`op` is required — 'append' (add blocks to a page), 'update_block' (replace one block's text in place), or 'update_properties' (patch page properties).",
		);
	}
	return args.op;
}

/** Reject arguments that mean nothing for this operation, rather than ignoring them. */
function assertArgsMatchOp(op: Op, args: UpdateNotionPageCall): void {
	const allowed = [...UNIVERSAL_ARGS, ...ALLOWED_ARGS[op]];
	const stray = Object.entries(args)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key)
		.filter((key) => !allowed.includes(key));
	if (stray.length > 0) {
		throw new Error(
			`op:'${op}' does not accept [${stray.join(", ")}]. It takes: ${ALLOWED_ARGS[op].join(", ")}.`,
		);
	}
}

async function withWorkspaceHint<T>(domain: Domain, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (err) {
		if (isNotionNotFound(err)) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
		}
		throw err;
	}
}

function requirePageId(args: UpdateNotionPageCall, op: Op): string {
	if (!args.page_id) {
		throw new Error(`op:'${op}' requires \`page_id\` — the target page's id or URL.`);
	}
	return normalizeNotionId(args.page_id);
}

async function runNotionPageUpdate(
	port: NotionPort,
	args: UpdateNotionPageCall,
): Promise<NotionPageUpdateOutput> {
	const domain = requireDomain(args.domain, "write to a Notion page");
	const op = requireOp(args);
	assertArgsMatchOp(op, args);

	if (op === "append") {
		const pageId = requirePageId(args, op);
		await refuseStateDocTarget(port, domain, pageId);
		if (!args.body?.trim()) {
			throw new Error("op:'append' requires `body` — the content to add, one block per line.");
		}
		const blocks = markdownToBlocks(args.body);
		if (blocks.length === 0) {
			throw new Error("`body` produced no blocks — it contains only blank lines.");
		}
		const afterId = args.after ? normalizeNotionId(args.after) : undefined;
		const appended = await withWorkspaceHint(domain, () =>
			port.appendBlockChildren({
				workspace: domain,
				blockId: pageId,
				children: blocks,
				...(afterId ? { after: afterId } : {}),
			}),
		);
		const blockIds = Array.isArray(appended)
			? appended.filter((id): id is string => typeof id === "string")
			: [];
		return {
			domain,
			op: "append",
			page_id: pageId,
			block_count: blocks.length,
			block_ids: blockIds,
			...(afterId ? { after: afterId } : {}),
		};
	}

	if (op === "update_block") {
		if (!args.block_id || !args.block_type || args.text === undefined) {
			throw new Error(
				"op:'update_block' requires `block_id`, `block_type` and `text` — read the block's id and type from notion_page_get first.",
			);
		}
		const blockId = normalizeNotionId(args.block_id);
		await refuseStateDocTarget(port, domain, blockId, true);
		const payload = {
			[args.block_type]: {
				rich_text: richTextRuns(args.text),
				...(args.checked !== undefined ? { checked: args.checked } : {}),
			},
		};
		await withWorkspaceHint(domain, () =>
			port.updateBlock({ workspace: domain, blockId, payload }),
		);
		return {
			domain,
			op: "update_block",
			block_id: blockId,
			block_ids: [blockId],
			block_type: args.block_type,
			block_count: 1,
		};
	}

	// op === "update_properties"
	const pageId = requirePageId(args, op);
	await refuseStateDocTarget(port, domain, pageId);
	const propertyNames = Object.keys(args.properties ?? {});
	// Any ONE of the three is a real edit, and all three travel in one PATCH (#1058).
	// The `properties`-only requirement this replaces would now reject a pure
	// archive — a call that names exactly what it wants done.
	if (propertyNames.length === 0 && args.archived === undefined && args.icon === undefined) {
		throw new Error(
			"op:'update_properties' requires at least one of `properties` (property NAME → raw Notion REST value shape), `archived` (true trashes the page, false restores it) or `icon`. Nothing was sent.",
		);
	}
	await withWorkspaceHint(domain, () =>
		port.updatePage({
			workspace: domain,
			pageId,
			// Each key is passed only when the caller supplied it. `icon: null` is a
			// real instruction to Notion ("remove the icon"), so undefined must not
			// become null here, and an absent `archived` must not become `false` —
			// that would silently restore a page someone had trashed on purpose.
			...(propertyNames.length > 0
				? { properties: args.properties as Record<string, unknown> }
				: {}),
			...(args.icon !== undefined ? { icon: args.icon as Record<string, unknown> } : {}),
			...(args.archived !== undefined ? { archived: args.archived } : {}),
		}),
	);
	return {
		domain,
		op: "update_properties",
		page_id: pageId,
		property_names: propertyNames,
		property_count: propertyNames.length,
		...(args.icon !== undefined ? { icon_updated: true } : {}),
		...(args.archived !== undefined ? { archived: args.archived } : {}),
	};
}

export const notionPageUpdateOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	op: z.enum(["append", "update_block", "update_properties"]),
	page_id: z.string().optional(),
	block_id: z.string().optional(),
	block_ids: z.array(z.string()).optional(),
	block_count: z.number().optional(),
	block_type: z.string().optional(),
	after: z.string().optional(),
	property_names: z.array(z.string()).optional(),
	property_count: z.number().optional(),
	icon_updated: z.boolean().optional(),
	archived: z.boolean().optional(),
});
export type NotionPageUpdateOutput = z.infer<typeof notionPageUpdateOutputSchema>;

export function formatNotionPageUpdateMcp(result: NotionPageUpdateOutput): string {
	if (result.op === "append") {
		return `Appended ${result.block_count ?? 0} block(s) to ${result.page_id} (domain='${result.domain}')${result.after ? " after the given sibling" : ""}.`;
	}
	if (result.op === "update_block") {
		return `Updated block ${result.block_id} (${result.block_type}, domain='${result.domain}').`;
	}
	const propertyNames = result.property_names ?? [];
	const did: string[] = [];
	if (propertyNames.length > 0) {
		did.push(
			`updated ${propertyNames.length} propert${propertyNames.length === 1 ? "y" : "ies"} (${propertyNames.join(", ")})`,
		);
	}
	if (result.icon_updated) did.push("set the icon");
	// Named as trash/restore rather than "archived", so the reply cannot be read as a
	// permanent delete by someone deciding whether they still have the page.
	if (result.archived === true) did.push("moved it to Notion's trash (restore with archived:false)");
	if (result.archived === false) did.push("restored it from Notion's trash");
	return `Page ${result.page_id} (domain='${result.domain}'): ${did.join("; ")}.`;
}

export function createNotionPageUpdateAction(
	port: NotionPort,
): ActionDefinition<typeof notionPageUpdateInputSchema, NotionPageUpdateOutput> {
	return defineAction({
		id: "notion_page_update",
		name: "notion_page_update",
		description:
			"Write to any Notion page — the write half of the page surface. `domain` ('work' or 'angus') " +
			"is REQUIRED, no default. Ops: 'append' blocks, 'update_block' to rewrite one block in place, " +
			"'update_properties' — which also sets `icon` and trashes or restores the page via `archived`. " +
			"Refuses State Doc pages. Full notes: docs/guides/tools/notion_page_update.md",
		domain: "integrations",
		schema: notionPageUpdateInputSchema,
		outputSchema: notionPageUpdateOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp: formatNotionPageUpdateMcp,
		async run(args: NotionPageUpdateInput, _context: ActionContext): Promise<NotionPageUpdateOutput> {
			return runNotionPageUpdate(port, args);
		},
	});
}

function requireDomain(domain: Domain | undefined, doing: string): Domain {
	if (!domain) {
		throw new Error(
			`\`domain\` is required to ${doing} — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.`,
		);
	}
	return domain;
}

function isNotionNotFound(err: unknown): boolean {
	return err instanceof Error && err.name === "NotionApiError" && (err as NotionApiError).status === 404;
}

function crossWorkspaceHint(domain: Domain): string {
	const provider = domain === "work" ? "notion_work" : "notion_personal";
	const other = DOMAINS.find((d) => d !== domain);
	return `Not found in the '${domain}' workspace (provider '${provider}'). The two workspaces have disjoint page access — if this page lives in the other one, retry with domain='${other}'.`;
}

function sameNotionId(a: string, b: string): boolean {
	const canonical = (v: string) => {
		try {
			return normalizeNotionId(v);
		} catch {
			return v.replace(/-/g, "").toLowerCase();
		}
	};
	return canonical(a) === canonical(b);
}

const STATE_DOC_REFUSAL = (domain: Domain) =>
	`This is the '${domain}' State Doc. Its sections are edited only through state_doc_update (ADR-053 one-writer rule) — use that tool, which addresses sections by exact heading and stamps 'Last updated' itself.`;

async function refuseStateDocTarget(
	port: NotionPort,
	domain: Domain,
	targetId: string,
	walkBlockParent = false,
): Promise<void> {
	if (!port.getStateDocPageId) {
		throw new Error("Cannot verify the State Doc guard (ADR-053): `getStateDocPageId` is not wired on NotionPort.");
	}
	const stateDocId = await port.getStateDocPageId(domain);
	if (!stateDocId) return;
	if (sameNotionId(stateDocId, targetId)) {
		throw new Error(STATE_DOC_REFUSAL(domain));
	}
	if (walkBlockParent && typeof port.retrieveBlock === "function") {
		let currentId = targetId;
		for (let hop = 0; hop < 12; hop++) {
			let block;
			try {
				block = await port.retrieveBlock({ workspace: domain, blockId: currentId });
			} catch {
				break;
			}
			const parent = block?.parent;
			if (!parent) break;
			if (parent.type === "page_id" && parent.page_id) {
				if (sameNotionId(stateDocId, parent.page_id)) {
					throw new Error(STATE_DOC_REFUSAL(domain));
				}
				break;
			}
			if (parent.type === "block_id" && parent.block_id) {
				currentId = parent.block_id;
				continue;
			}
			break;
		}
	}
}


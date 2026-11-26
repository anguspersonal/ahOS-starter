import { z } from "zod";
import { DOMAINS, DOMAIN_PROVIDER, type Domain } from "../../domain/domains.js";
import {
	notionConfigSchema,
	notionPersonalConfigSchema,
} from "../../domain/integrations.js";
import {
	blockRichText,
	buildHeadingBlock,
	buildLastUpdatedText,
	findHeadingIndexes,
	findLastUpdatedBlock,
	findSectionSpan,
	headerRegion,
	parseSectionBody,
	rewriteLastUpdatedLine,
	sectionBodyBlocks,
	type BlockPayload,
	type HeadingLevel,
} from "../../domain/stateDoc.js";
import type { ConfigRepository } from "../../ports/config.js";
import type { NotionBlock, NotionPort } from "../../ports/notion.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";

export const updateStateDocInput = {
	// Not `.optional()`-free by accident: these ARE required, but the requirement is
	// enforced by requireDomain()/requireOp() inside the handler rather than at this
	// zod-shape level. A hard-required field here would make the MCP SDK's own
	// safeParseAsync (server/mcp.js validateToolInput) reject a malformed call with a
	// generic "Required" schema error *before* the handler ever runs - which would bury
	// the ADR-053 back-compat message below for exactly the caller (a stale append-only
	// shape) it exists to help. `.optional()` here lets an omitted domain/op reach the
	// handler; a WRONG value (not one of the enum members) still fails schema
	// validation, since only *missing* is meant to fall through.
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which State Doc to write: 'work' (the Work workspace) or 'angus' (the personal workspace). Each resolves its own page pointer AND its own Notion token \u2014 there is no default, because a destination that defaults silently is one that will one day be wrong (ADR-054 \u00a79).",
		),
	op: z
		.enum(["replace", "rename", "insert", "delete"])
		.optional()
		.describe(
			"Required. replace: rewrite a section's body, keeping its heading. rename: rewrite the heading (and optionally the body) in one call. insert: add a new section at an explicit anchor. delete: remove a section entirely.",
		),
	heading: z
		.string()
		.min(1)
		.optional()
		.describe(
			"replace | rename | delete: the EXACT heading text of the section to act on, copied verbatim from the page. Zero matches or more than one is an error, never a guess.",
		),
	new_heading: z
		.string()
		.min(1)
		.optional()
		.describe(
			"rename: the heading text to write. insert: the heading of the new section. Must not duplicate a heading already on the page.",
		),
	body: z
		.string()
		.optional()
		.describe(
			"The section's new body, one block per line. '- ' / '* ' become bullets, '- [ ]' / '- [x]' to-dos, '1. ' numbered items, '> ' quotes; anything else is a paragraph. Inline markdown ([label](url), **bold**, *italic*, `code`, ~~strikethrough~~) is parsed into Notion rich_text runs. Required for replace; optional for rename and insert; rejected for delete.",
		),
	after_heading: z
		.string()
		.min(1)
		.optional()
		.describe("insert anchor: place the new section after the whole section with this exact heading."),
	before_heading: z
		.string()
		.min(1)
		.optional()
		.describe("insert anchor: place the new section immediately before the section with this exact heading."),
	at_end: z.boolean().optional().describe("insert anchor: place the new section at the end of the page."),
	heading_level: z
		.union([z.literal(1), z.literal(2), z.literal(3)])
		.optional()
		.describe("insert only: heading level for the new section. Defaults to 2."),
};

export const stateDocUpdateInput = updateStateDocInput;

export const stateDocUpdateInputSchema = z.object(updateStateDocInput);
export const stateDocUpdateSchema = stateDocUpdateInputSchema;

export type StateDocUpdateInput = z.infer<typeof stateDocUpdateInputSchema>;
export type UpdateStateDocCall = Partial<StateDocUpdateInput>;

type Op = NonNullable<StateDocUpdateInput["op"]>;

export const stateDocUpdateOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	pageId: z.string(),
	op: z.enum(["replace", "rename", "insert", "delete"]),
	headings: z.array(z.string()),
	summary: z.string(),
	stamp: z.string().nullable(),
});

export type StateDocUpdateOutput = z.infer<typeof stateDocUpdateOutputSchema>;

export interface StateDocUpdatePorts {
	notion: NotionPort;
	config?: ConfigRepository;
}

function isStateDocUpdatePorts(
	value: StateDocUpdatePorts | NotionPort,
): value is StateDocUpdatePorts {
	return "notion" in value;
}

export function formatStateDocUpdateMcp(result: StateDocUpdateOutput): string {
	const stampNote = result.stamp
		? `Stamped: ${result.stamp}`
		: 'No "Last updated" line found in the page header, so nothing was stamped \u2014 the page will keep reporting its previous date until one is added.';
	return `State Doc (${result.domain}): ${result.summary}. ${stampNote}`;
}

/** Accepted by every operation: which doc, and which operation. */
const UNIVERSAL_ARGS = ["domain", "op"] as const;

/** Which further arguments each operation accepts. Anything else is rejected loudly. */
const ALLOWED_ARGS: Record<Op, readonly string[]> = {
	replace: ["heading", "body"],
	rename: ["heading", "new_heading", "body"],
	insert: ["new_heading", "body", "after_heading", "before_heading", "at_end", "heading_level"],
	delete: ["heading"],
};

/** One Notion write. A plan is built in full before any of it executes. */
type Step =
	| { kind: "append"; children: BlockPayload[]; after?: string }
	| { kind: "update"; blockId: string; payload: Record<string, unknown> }
	| { kind: "delete"; blockId: string };

type WritePlan = {
	steps: Step[];
	/** Sections touched, for the `Last updated` stamp. */
	headings: string[];
	summary: string;
};

const OPS = "replace | rename | insert | delete";

/**
 * Reject the retired append-only call shape before anything else happens. The old
 * tool took `heading` + `body` and appended a new section every run; silently
 * treating that as one of the new operations would edit a page that is read at the
 * start of every session.
 */
function requireOp(args: UpdateStateDocCall): Op {
	if (!args.op) {
		throw new Error(
			`state_doc_update no longer appends to the State Doc (ADR-053). \`op\` is required \u2014 one of ${OPS}. To rewrite a section: op:'replace' with \`heading\` (exact) + \`body\`. To add one: op:'insert' with \`new_heading\` and an anchor (after_heading / before_heading / at_end).`,
		);
	}
	return args.op;
}

/**
 * Reject the missing destination. Required rather than defaulted for the same reason
 * `op` is: there are two State Docs in two workspaces on two tokens (ADR-054 \u00a79), and a
 * destination that defaults silently is one that will one day be wrong.
 */
function requireDomain(args: UpdateStateDocCall): Domain {
	if (!args.domain) {
		throw new Error(
			"`domain` is required \u2014 'work' (the Work State Doc) or 'angus' (the personal one). There is no default: each domain is a different page in a different Notion workspace behind a different token.",
		);
	}
	return args.domain;
}

/** Reject arguments that mean nothing for this operation, rather than ignoring them. */
function assertArgsMatchOp(op: Op, args: UpdateStateDocCall): void {
	const allowed = [...UNIVERSAL_ARGS, ...ALLOWED_ARGS[op]];
	const supplied = Object.entries(args)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key);
	const stray = supplied.filter((key) => !allowed.includes(key));

	if (stray.length > 0) {
		throw new Error(
			`op:'${op}' does not take ${stray.map((k) => `\`${k}\``).join(", ")}. It takes ${ALLOWED_ARGS[
				op
			]
				.map((k) => `\`${k}\``)
				.join(", ")}.`,
		);
	}
}

function requireBody(op: Op, args: UpdateStateDocCall): BlockPayload[] {
	const blocks = args.body ? parseSectionBody(args.body) : [];
	if (blocks.length === 0) {
		throw new Error(
			`op:'${op}' needs a non-empty \`body\`. To empty a section, delete it (op:'delete') so the page does not keep a heading with nothing under it.`,
		);
	}
	return blocks;
}

function assertHeadingIsFree(blocks: NotionBlock[], heading: string): void {
	if (findHeadingIndexes(blocks, heading).length > 0) {
		throw new Error(
			`"${heading}" is already a heading on the State Doc. Sections are addressed by exact heading text (ADR-053), so a duplicate would make both unaddressable.`,
		);
	}
}

/** The heading block's own annotations, so a rename keeps the heading looking the same. */
function headingAnnotations(block: NotionBlock): Record<string, unknown> | undefined {
	return blockRichText(block)[0]?.annotations;
}

function planReplace(blocks: NotionBlock[], args: UpdateStateDocCall): WritePlan {
	const span = findSectionSpan(blocks, args.heading as string);
	const body = requireBody("replace", args);
	const old = sectionBodyBlocks(blocks, span);

	// Insert first, delete second: a failure between the two leaves the section
	// duplicated (visible, one more call to fix) rather than emptied.
	return {
		steps: [
			{ kind: "append", children: body, after: blocks[span.headingIndex].id },
			...old.map((b): Step => ({ kind: "delete", blockId: b.id })),
		],
		headings: [span.heading],
		summary: `replaced section "${span.heading}" (${old.length} block(s) \u2192 ${body.length})`,
	};
}

function planRename(blocks: NotionBlock[], args: UpdateStateDocCall): WritePlan {
	const span = findSectionSpan(blocks, args.heading as string);
	const newHeading = (args.new_heading as string).trim();

	if (newHeading === span.heading) {
		throw new Error(
			`\`new_heading\` is identical to \`heading\` ("${span.heading}"). Use op:'replace' to rewrite the body without renaming.`,
		);
	}
	assertHeadingIsFree(blocks, newHeading);

	const headingBlock = blocks[span.headingIndex];
	const steps: Step[] = [
		{
			kind: "update",
			blockId: headingBlock.id,
			payload: {
				[headingBlock.type]: {
					rich_text: [
						{
							type: "text",
							text: { content: newHeading },
							...(headingAnnotations(headingBlock)
								? { annotations: headingAnnotations(headingBlock) }
								: {}),
						},
					],
				},
			},
		},
	];

	let summary = `renamed section "${span.heading}" \u2192 "${newHeading}"`;

	// Body is optional here: the weekly `This week focus - Week ...` case changes both,
	// but a heading-only rename should not force the caller to resend prose it did not
	// mean to touch.
	if (args.body !== undefined) {
		const body = requireBody("rename", args);
		const old = sectionBodyBlocks(blocks, span);
		steps.push({ kind: "append", children: body, after: headingBlock.id });
		steps.push(...old.map((b): Step => ({ kind: "delete", blockId: b.id })));
		summary += ` and replaced its body (${old.length} block(s) \u2192 ${body.length})`;
	}

	return { steps, headings: [newHeading], summary };
}

function planInsert(blocks: NotionBlock[], args: UpdateStateDocCall): WritePlan {
	const anchors = [
		args.after_heading !== undefined,
		args.before_heading !== undefined,
		args.at_end === true,
	].filter(Boolean).length;

	if (anchors !== 1) {
		throw new Error(
			`op:'insert' needs exactly one anchor: \`after_heading\`, \`before_heading\`, or \`at_end: true\`. Position is always something the caller asked for, never inferred (ADR-053).`,
		);
	}

	const newHeading = (args.new_heading as string).trim();
	assertHeadingIsFree(blocks, newHeading);

	const body = args.body !== undefined ? requireBody("insert", args) : [];
	const level = (args.heading_level ?? 2) as HeadingLevel;
	const children = [buildHeadingBlock(newHeading, level), ...body];

	let after: string | undefined;
	let where: string;

	if (args.after_heading !== undefined) {
		// After the whole anchor SECTION, not just its heading - otherwise the new
		// section would land inside the anchor's body.
		const span = findSectionSpan(blocks, args.after_heading);
		after = blocks[span.end - 1].id;
		where = `after "${span.heading}"`;
	} else if (args.before_heading !== undefined) {
		const span = findSectionSpan(blocks, args.before_heading);
		if (span.headingIndex === 0) {
			throw new Error(
				`Cannot insert before "${span.heading}": it is the first block on the page, and Notion can only append after an existing block. Insert after another section instead.`,
			);
		}
		after = blocks[span.headingIndex - 1].id;
		where = `before "${span.heading}"`;
	} else {
		after = undefined;
		where = "at the end of the page";
	}

	return {
		steps: [{ kind: "append", children, after }],
		headings: [newHeading],
		summary: `inserted section "${newHeading}" ${where} (${body.length} body block(s))`,
	};
}

function planDelete(blocks: NotionBlock[], args: UpdateStateDocCall): WritePlan {
	const span = findSectionSpan(blocks, args.heading as string);
	const headingBlock = blocks[span.headingIndex];
	const body = sectionBodyBlocks(blocks, span);

	// Body blocks first, heading last - the same failure-direction reasoning as
	// `replace`'s insert-before-delete (see the comment there), applied to the one
	// case that has no substitute write to order around.
	return {
		steps: [...body, headingBlock].map((b): Step => ({ kind: "delete", blockId: b.id })),
		headings: [span.heading],
		summary: `deleted section "${span.heading}" (${body.length + 1} block(s))`,
	};
}

function planOperation(op: Op, args: UpdateStateDocCall, blocks: NotionBlock[]): WritePlan {
	switch (op) {
		case "replace":
			return planReplace(blocks, args);
		case "rename":
			return planRename(blocks, args);
		case "insert":
			return planInsert(blocks, args);
		case "delete":
			return planDelete(blocks, args);
	}
}

/** Required arguments per op, checked before the page is fetched. */
function assertRequiredArgs(op: Op, args: UpdateStateDocCall): void {
	const missing: string[] = [];
	if (op !== "insert" && !args.heading) missing.push("`heading`");
	if ((op === "rename" || op === "insert") && !args.new_heading) missing.push("`new_heading`");
	if (op === "replace" && args.body === undefined) missing.push("`body`");
	if (missing.length > 0) {
		throw new Error(`op:'${op}' requires ${missing.join(" and ")}.`);
	}
}

async function resolveTargetPageId(
	domain: Domain,
	notion: NotionPort,
	config?: ConfigRepository,
): Promise<string> {
	const provider = DOMAIN_PROVIDER[domain];

	let pageId: string | undefined;
	if (config) {
		const loaded =
			domain === "work"
				? await config.loadConfig(provider, notionConfigSchema)
				: await config.loadConfig(provider, notionPersonalConfigSchema);
		pageId = loaded?.state_doc_page_id;
	} else if (notion.getStateDocPageId) {
		pageId = await notion.getStateDocPageId(domain);
	}

	if (!pageId) {
		throw new Error(
			domain === "work"
				? "No state_doc_page_id in your Notion integration config. Add it to the 'notion_work' row in user_integrations (and share that page with your integration)."
				: [
						"No state_doc_page_id for domain 'angus' \u2014 the personal State Doc is unwired, so nothing was written.",
						"Wire it in two steps:",
						`1. integration_set({ provider: '${provider}', config: { state_doc_page_id: '<page id of the personal Personal Daily Operating System>' } })`,
						"2. In personal Notion, open that page \u2192 \u22ef \u2192 Connections \u2192 ahKMS, and do the same for its parent. Notion exposes no page-sharing API, so without this step every configured pointer 404s (#355).",
					].join("\n"),
		);
	}

	await notion.resolveToken(domain);
	return pageId;
}

async function listAllBlockChildren(
	notion: NotionPort,
	domain: Domain,
	blockId: string,
): Promise<NotionBlock[]> {
	const blocks: NotionBlock[] = [];
	let cursor: string | undefined;

	do {
		const page = await notion.listBlockChildren({
			workspace: domain,
			blockId,
			...(cursor ? { startCursor: cursor } : {}),
		});
		blocks.push(...((page.results ?? []) as unknown as NotionBlock[]));
		cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
	} while (cursor);

	return blocks;
}

async function stampLastUpdated(
	notion: NotionPort,
	domain: Domain,
	blocks: NotionBlock[],
	op: Op,
	headings: string[],
): Promise<string | null> {
	const header = headerRegion(blocks);
	let target = findLastUpdatedBlock(header);

	// The stamp may sit inside the callout rather than on it.
	if (!target) {
		for (const block of header.filter((b) => b.has_children)) {
			const children = await listAllBlockChildren(notion, domain, block.id);
			target = findLastUpdatedBlock(children);
			if (target) break;
		}
	}
	if (!target) return null;

	const text = buildLastUpdatedText(op, headings);
	const richText = rewriteLastUpdatedLine(blockRichText(target), text);
	if (!richText) return null;

	await notion.updateBlock({
		workspace: domain,
		blockId: target.id,
		payload: { [target.type]: { rich_text: richText } },
	});
	return text;
}

async function executeSteps(
	notion: NotionPort,
	domain: Domain,
	pageId: string,
	steps: Step[],
): Promise<void> {
	for (const step of steps) {
		if (step.kind === "append") {
			await notion.appendBlockChildren({
				workspace: domain,
				blockId: pageId,
				children: step.children as Record<string, unknown>[],
				...(step.after ? { after: step.after } : {}),
			});
		} else if (step.kind === "update") {
			await notion.updateBlock({
				workspace: domain,
				blockId: step.blockId,
				payload: step.payload,
			});
		} else {
			await notion.deleteBlock({
				workspace: domain,
				blockId: step.blockId,
			});
		}
	}
}

export function createStateDocUpdateAction(
	portsOrNotion: StateDocUpdatePorts | NotionPort,
): ActionDefinition<typeof stateDocUpdateInputSchema, StateDocUpdateOutput> {
	const notion = isStateDocUpdatePorts(portsOrNotion) ? portsOrNotion.notion : portsOrNotion;
	const config = isStateDocUpdatePorts(portsOrNotion) ? portsOrNotion.config : undefined;

	return defineAction({
		id: "state_doc_update",
		name: "state_doc_update",
		description:
			"Edit ONE section of a Notion State Doc, addressed by exact heading. `domain` ('work' or " +
			"'angus') is REQUIRED \u2014 a different page behind a different token, with no default. This is the " +
			"State Doc's only writer (ADR-053); it stamps 'Last updated' itself. Full notes: " +
			"docs/guides/tools/state_doc_update.md",
		domain: "ops",
		schema: stateDocUpdateInputSchema,
		outputSchema: stateDocUpdateOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp: formatStateDocUpdateMcp,
		async run(input: StateDocUpdateInput, _ctx: ActionContext): Promise<StateDocUpdateOutput> {
			const op = requireOp(input);
			const domain = requireDomain(input);
			assertArgsMatchOp(op, input);
			assertRequiredArgs(op, input);

			const pageId = await resolveTargetPageId(domain, notion, config);
			const blocks = await listAllBlockChildren(notion, domain, pageId);

			const plan = planOperation(op, input, blocks);
			await executeSteps(notion, domain, pageId, plan.steps);
			const stamp = await stampLastUpdated(notion, domain, blocks, op, plan.headings);

			return {
				domain,
				pageId,
				op,
				headings: plan.headings,
				summary: plan.summary,
				stamp,
			};
		},
	});
}

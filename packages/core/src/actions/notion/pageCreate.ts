import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type { NotionApiError, NotionCreatePageParams, NotionPort } from "../../ports/notion.js";
import { normalizeNotionId } from "./pageGet.js";
import { createNotionDatabaseGetAction } from "./databaseGet.js";
import {
	assertOptionsMatchSchema,
	assertPropertiesMatchSchema,
	resolveTitleProperty,
} from "./schemaGuard.js";
import { markdownToBlocks, type BlockPayload } from "./blocks.js";
import { ExternalItemCreatedButUnreadable } from "../outwardWrite.js";

// The general Notion create (#1057). Before this, ahKMS could read any page and edit
// any page, but could only CREATE into three fixed destinations (task_create,
// daily_log_create, state_doc_update). ADR-081 made ahKMS the only Notion path on
// every surface, so "create a Meetings row" was not an inconvenience — it was
// impossible from any surface, which is how it was found.
//
// Two design notes worth having before editing:
//
// 1. Properties are raw Notion REST shapes, not a friendly dialect. A dialect has to be
//    extended for every property type Notion has or grows, and the half that is not
//    modelled fails at the API with an error written about JSON the caller never sent.
//    The title is the one exception: a database names its own title property, so the
//    caller cannot know the key, and `title` is taken as a plain string.
//
// 2. Everything checkable is checked before the first write. That matters more for
//    select-like properties than it looks: Notion answers an unknown `select` option by
//    CREATING it and returning 200, so a typo lands as a real row against a real-looking
//    new option and nothing downstream ever reports it (see notionSchemaGuard.ts).

const CHILDREN_PER_CALL = 100;

export const notionPageCreateInput = {
	domain: z
		.enum(DOMAINS)
		.describe(
			"Which workspace: 'work' (work) or 'angus' (personal). Required, no default — each is a separate Notion integration and sees only its own pages.",
		),
	database_id: z
		.string()
		.optional()
		.describe(
			"Create a row in this database. The *_database_id notion_config_get prints. Exactly one of database_id / data_source_id / parent_page_id.",
		),
	data_source_id: z
		.string()
		.optional()
		.describe(
			"Create a row in the database behind this data source. The *_data_source_id notion_config_get prints; it is resolved to its database first.",
		),
	parent_page_id: z
		.string()
		.optional()
		.describe(
			"Create a child page under this ordinary page. Accepts an id or a Notion URL. A page parent has no schema, so only the title applies.",
		),
	title: z.string().describe("The page title. Written into whichever property the database declares as its title."),
	properties: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Other properties, keyed by the property NAME, in Notion's own REST shapes — e.g. {\"Event time\": {\"date\": {\"start\": \"2026-09-14T10:00:00Z\"}}, \"Type\": {\"select\": {\"name\": \"General\"}}}. Validated against the schema before anything is written. Ignored for a page parent.",
		),
	body: z
		.string()
		.optional()
		.describe(
			"Page body as Markdown — headings, bullets, paragraphs. Rendered to blocks, one per line, so it is not subject to Notion's 2000-character single-run cap.",
		),
	icon: z.string().optional().describe("A single emoji for the page icon."),
} as const;

export const notionPageCreateInputSchema = z.object(notionPageCreateInput);
export type NotionPageCreateCall = z.infer<typeof notionPageCreateInputSchema>;
export type NotionPageCreateInput = NotionPageCreateCall;

/** Exactly one parent, named in the caller's own vocabulary rather than Notion's. */
function resolveParentChoice(args: NotionPageCreateCall): {
	kind: "database" | "data_source" | "page";
	id: string;
} {
	const given = [
		args.database_id ? ({ kind: "database", id: args.database_id } as const) : null,
		args.data_source_id ? ({ kind: "data_source", id: args.data_source_id } as const) : null,
		args.parent_page_id ? ({ kind: "page", id: args.parent_page_id } as const) : null,
	].filter((c): c is NonNullable<typeof c> => c !== null);

	if (given.length !== 1) {
		throw new Error(
			given.length === 0
				? "Pass exactly one parent: `database_id` or `data_source_id` (a row in a database) or `parent_page_id` (a child page under a page). Nothing was written."
				: `Pass exactly one parent, not ${given.length} (${given.map((g) => g.kind).join(", ")}). They address different destinations, so there is no sensible way to merge them. Nothing was written.`,
		);
	}
	return given[0];
}

async function withWorkspaceHint<T>(domain: Domain, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (err) {
		// A page missing from one workspace routinely lives in the other; a bare 404 reads
		// as "does not exist" and sends the caller looking for the wrong problem (#424).
		if (isNotionNotFound(err)) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
		}
		throw err;
	}
}

async function runNotionPageCreate(
	port: NotionPort,
	args: NotionPageCreateCall,
	context: ActionContext,
): Promise<NotionPageCreateOutput> {
	const domain = requireDomain(args.domain, "create a Notion page");
	const parent = resolveParentChoice(args);

	const title = args.title.trim();
	if (!title) {
		throw new Error("`title` is required and must not be blank — an untitled row is unfindable in Notion's UI.");
	}

	const blocks: BlockPayload[] = args.body ? markdownToBlocks(args.body) : [];
	const icon = args.icon ? { emoji: args.icon } : undefined;

	if (parent.kind === "page") {
		const parentPageId = normalizeNotionId(parent.id);
		await refuseStateDocTarget(port, domain, parentPageId);

		// A page parent takes no schema: Notion's only accepted property is `title`.
		return buildCreateReceipt(
			await create(
				domain,
				{
					workspace: domain,
					parentPageId,
					properties: { title: { title: [{ text: { content: title } }] } },
					children: blocks.slice(0, CHILDREN_PER_CALL),
					icon,
				},
				port,
			),
			parentPageId,
			blocks,
			port,
			domain,
		);
	}

	// The Daily Log has one writer (#1017). Checked on the id as given before any Notion
	// call, then again on the resolved database, which catches a data source id the
	// config does not name.
	await refuseDailyLogTarget(port, domain, [parent.id]);

	// `parent: { database_id }` is the 2022-06-28 write shape, and the id a caller most
	// often has is the data source's (the 2025-09-03 READ handle). Resolve rather than
	// refuse: Notion's own error for the wrong one names neither id.
	const databaseId =
		parent.kind === "data_source"
			? await withWorkspaceHint(domain, () => retrieveDataSourceDatabaseId(parent.id, port, domain))
			: normalizeNotionId(parent.id);
	if (parent.kind === "data_source") await refuseDailyLogTarget(port, domain, [databaseId]);

	const schema = await createNotionDatabaseGetAction(port).run({ domain, database_id: databaseId }, context);
	const titleProperty = resolveTitleProperty(schema, databaseId);

	const supplied = args.properties ?? {};
	assertPropertiesMatchSchema(supplied, schema, {
		destination: "this database",
		reserved: { title: titleProperty },
	});
	assertOptionsMatchSchema(supplied, schema, { destination: "this database" });

	return buildCreateReceipt(
		await create(
			domain,
			{
				workspace: domain,
				databaseId,
				properties: {
					[titleProperty]: { title: [{ text: { content: title } }] },
					...supplied,
				},
				children: blocks.slice(0, CHILDREN_PER_CALL),
				icon,
			},
			port,
		),
		databaseId,
		blocks,
		port,
		domain,
	);
}

type Created = { id: string; url: string; unreadable: boolean };

async function create(
	domain: Domain,
	input: NotionCreatePageParams,
	port: NotionPort,
): Promise<Created> {
	try {
		const page = await port.createPage(input);
		return { ...page, unreadable: false };
	} catch (err) {
		// Notion ACCEPTED the create and the response body was unreadable: the page exists,
		// its id does not. Reporting this as a write failure invites a retry that creates a
		// second page (#653, outwardWrite.ts) — so say what happened instead.
		if (err instanceof ExternalItemCreatedButUnreadable) {
			return { id: "", url: "", unreadable: true };
		}
		if (isNotionNotFound(err)) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
		}
		throw err;
	}
}

async function buildCreateReceipt(
	page: Created,
	parentId: string,
	blocks: BlockPayload[],
	port: NotionPort,
	domain: Domain,
): Promise<NotionPageCreateOutput> {
	if (page.unreadable) {
		return {
			domain,
			page_id: "",
			url: "",
			parent_id: parentId,
			block_count: 0,
			block_ids: [],
			unreadable: true,
		};
	}

	// Notion caps `children` at 100 per call, so a long body arrives in follow-up
	// appends. The page already exists at this point; an append that fails leaves a
	// short page rather than no page, and that is worth saying rather than throwing.
	const rest = blocks.slice(CHILDREN_PER_CALL);
	const blockIds: string[] = [];
	let unappendedBlockCount: number | undefined;
	let appendError: string | undefined;
	let appendedBlocks = Math.min(blocks.length, CHILDREN_PER_CALL);
	for (let i = 0; i < rest.length; i += CHILDREN_PER_CALL) {
		const chunk = rest.slice(i, i + CHILDREN_PER_CALL);
		try {
			// `token` is the FOURTH argument and defaults to the Work credential when
			// omitted — passing it third appends a personal page's body under the work
			// token, which is #424 defect 1 exactly.
			const appended = await port.appendBlockChildren({
				workspace: domain,
				blockId: page.id,
				children: chunk,
			});
			if (Array.isArray(appended)) {
				for (const id of appended) {
					if (typeof id === "string") blockIds.push(id);
				}
			}
			appendedBlocks += chunk.length;
		} catch (err) {
			unappendedBlockCount = rest.length - i;
			appendError = err instanceof Error ? err.message : String(err);
			break;
		}
	}

	return {
		domain,
		page_id: page.id,
		url: page.url,
		parent_id: parentId,
		block_count: appendedBlocks,
		block_ids: blockIds,
		...(unappendedBlockCount !== undefined ? { unappended_block_count: unappendedBlockCount } : {}),
		...(appendError !== undefined ? { append_error: appendError } : {}),
	};
}

export const notionPageCreateOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	page_id: z.string(),
	url: z.string(),
	parent_id: z.string(),
	block_count: z.number(),
	block_ids: z.array(z.string()),
	unreadable: z.boolean().optional(),
	unappended_block_count: z.number().optional(),
	append_error: z.string().optional(),
});
export type NotionPageCreateOutput = z.infer<typeof notionPageCreateOutputSchema>;

export function formatNotionPageCreateMcp(result: NotionPageCreateOutput): string {
	if (result.unreadable) {
		return [
			`The page WAS created in the '${result.domain}' workspace, but Notion's response could not be read, so its id and url are unknown.`,
			"Do NOT retry this call — a retry creates a second page. Find it with notion_search by its title.",
		].join("\n");
	}
	const notes: string[] = [];
	if (result.unappended_block_count !== undefined && result.append_error !== undefined) {
		notes.push(
			`The page exists, but ${result.unappended_block_count} further block(s) of the body could not be appended: ${result.append_error}`,
		);
	}
	return [`Created in '${result.domain}': ${result.page_id}`, result.url || "(no url returned)", ...notes]
		.filter(Boolean)
		.join("\n");
}

export function createNotionPageCreateAction(
	port: NotionPort,
): ActionDefinition<typeof notionPageCreateInputSchema, NotionPageCreateOutput> {
	return defineAction({
		id: "notion_page_create",
		name: "notion_page_create",
		description:
			"Create a page in either Notion workspace: a row in a database, or a child page under a page. `properties` are Notion's own REST shapes, validated against the database schema before anything is written — an unknown select option is refused here because Notion would silently create it instead. State Doc and Daily Log refused: they have their own writers.",
		domain: "integrations",
		schema: notionPageCreateInputSchema,
		outputSchema: notionPageCreateOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp: formatNotionPageCreateMcp,
		async run(args: NotionPageCreateCall, context: ActionContext): Promise<NotionPageCreateOutput> {
			return runNotionPageCreate(port, args, context);
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

async function refuseStateDocTarget(port: NotionPort, domain: Domain, pageId: string): Promise<void> {
	if (!port.getStateDocPageId) {
		throw new Error("Cannot verify the State Doc guard (ADR-053): `getStateDocPageId` is not wired on NotionPort.");
	}
	const stateDocId = await port.getStateDocPageId(domain);
	if (stateDocId && sameNotionId(stateDocId, pageId)) {
		throw new Error(
			`This is the '${domain}' State Doc. Its sections are edited only through state_doc_update (ADR-053 one-writer rule) — use that tool, which addresses sections by exact heading and stamps 'Last updated' itself.`,
		);
	}
}

async function refuseDailyLogTarget(port: NotionPort, domain: Domain, ids: string[]): Promise<void> {
	if (!port.getDailyLogTargetIds) {
		throw new Error("Cannot verify the Daily Log guard (ADR-051 §11): `getDailyLogTargetIds` is not wired on NotionPort.");
	}
	const dailyLog = await port.getDailyLogTargetIds(domain);
	if (!ids.some((id) => dailyLog.some((p) => sameNotionId(p, id)))) return;
	throw new Error(
		`This is the '${domain}' Daily Log. Its entries are written only by the dos ritual, through daily_log_create (ADR-051 §11): one entry per domain per date, and a row filed here would hold its date against the ritual's own write, so that day could never be closed. To record a working session or a note, use capture; dos folds it into the day.`,
	);
}

async function retrieveDataSourceDatabaseId(dataSourceId: string, port: NotionPort, domain: Domain): Promise<string> {
	const id = normalizeNotionId(dataSourceId);
	const ds = await port.retrieveDataSource({ workspace: domain, dataSourceId: id });
	const dbId = ds.parent?.database_id;
	if (!dbId) {
		throw new Error(
			`Data source ${id} reports no parent database, so there is no id to create pages against. Pass \`database_id\` directly.`,
		);
	}
	return dbId;
}

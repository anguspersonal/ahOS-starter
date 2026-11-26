import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type {
	NotionApiError,
	NotionPageResponse,
	NotionPort,
	NotionQueryDataSourceResponse,
} from "../../ports/notion.js";
import { normalizeNotionId, propertyPlain } from "./pageGet.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

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

export const queryNotionDatabaseInputSchema = z.object({
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which workspace the database lives in: 'work' (the Work workspace) or 'angus' (the personal one). No default: the two are separate Notion integrations with disjoint access (ADR-054 §9), and a data source missing from one may be sitting in the other.",
		),
	data_source_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The data source to query: a 32-hex Notion id (dashed or not) or a full URL carrying one. This is the READ half of a database under Notion's 2025-09-03 API, the id notion_config_get prints for every *_data_source_id key (tasks_source_data_source_id, meetings_source_data_source_id, daily_log_data_source_id, ...). A *_database_id is the container and is refused by Notion here.",
		),
	filter: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'Notion\'s own filter object, passed through untouched. One condition: {"property":"Status","status":{"does_not_equal":"Done"}}. Compound: {"and":[{...},{...}]} / {"or":[...]}. Property names are the database\'s exact names; the value shape depends on the property type (status, select, multi_select, date, checkbox, people, relation, rich_text, title, number). An invalid filter comes back as Notion\'s validation error, verbatim.',
		),
	sorts: z
		.array(z.record(z.string(), z.unknown()))
		.optional()
		.describe(
			'Notion\'s own sorts array, passed through: [{"property":"Due date","direction":"ascending"}] or [{"timestamp":"last_edited_time","direction":"descending"}]. Applied in order.',
		),
	properties: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Property NAMES to show per row, in this order. Omitted, every property is rendered. The title property is always the row heading and is never repeated as a column, so leave it out of this list. Narrow this on wide databases: a Tasks DB with twelve properties and a hundred rows is a lot of text nobody reads.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_LIMIT)
		.optional()
		.describe(
			`Rows per call (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}, Notion's own page cap). More rows come back as a next_cursor, never as a silent cut.`,
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe("The next_cursor from a previous call, to fetch the following page of rows."),
});

export type QueryNotionDatabaseInput = z.infer<typeof queryNotionDatabaseInputSchema>;

export const notionDatabaseQueryRowSchema = z.object({
	id: z.string(),
	url: z.string(),
	title: z.string(),
	last_edited_time: z.string().nullable(),
	properties: z.record(z.string(), z.string()),
});

export type NotionDatabaseQueryRow = z.infer<typeof notionDatabaseQueryRowSchema>;

export const notionDatabaseQueryOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	dataSourceId: z.string(),
	rows: z.array(notionDatabaseQueryRowSchema),
	hasMore: z.boolean(),
	nextCursor: z.string().nullable(),
	archivedCount: z.number(),
	filter: z.record(z.string(), z.unknown()).optional(),
	sorts: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type NotionDatabaseQueryOutput = z.infer<typeof notionDatabaseQueryOutputSchema>;

function rowTitle(page: NotionPageResponse): string {
	for (const value of Object.values(page.properties ?? {})) {
		const v = value as Record<string, unknown>;
		if (v && typeof v === "object" && v.type === "title") return propertyPlain(v);
	}
	return "(untitled)";
}

export function flattenRow(page: NotionPageResponse, only?: string[]): NotionDatabaseQueryRow {
	const all = Object.entries(page.properties ?? {}) as Array<[string, Record<string, unknown>]>;
	const chosen = only
		? only.map((name) => [name, (page.properties ?? {})[name]] as [string, Record<string, unknown> | undefined])
		: all;
	const properties: Record<string, string> = {};
	for (const [name, value] of chosen) {
		if (value === undefined) {
			properties[name] = "(no such property)";
			continue;
		}
		if ((value as Record<string, unknown>).type === "title") continue;
		properties[name] = propertyPlain(value as Record<string, unknown>);
	}
	return {
		id: page.id,
		url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
		title: rowTitle(page),
		last_edited_time: page.last_edited_time ?? null,
		properties,
	};
}

function renderRow(row: NotionDatabaseQueryRow, index: number): string {
	const lines = [`${index + 1}. ${row.title}  (id ${row.id})`];
	for (const [name, value] of Object.entries(row.properties)) {
		lines.push(`   ${name}: ${value}`);
	}
	return lines.join("\n");
}

export function formatNotionDatabaseQueryMcp(result: NotionDatabaseQueryOutput): string {
	const other = DOMAINS.find((d) => d !== result.domain);
	if (result.rows.length === 0) {
		const lines = [
			`0 rows on this page from data source ${result.dataSourceId} in the '${result.domain}' workspace${result.filter ? " with the given filter" : ""}.`,
		];
		if (result.hasMore && result.nextCursor) {
			lines.push(
				`More rows exist${result.archivedCount ? ` (this page held ${result.archivedCount} archived row(s), not listed)` : ""}. Pass cursor '${result.nextCursor}' to fetch the next page; do not treat this as an empty result.`,
			);
		} else {
			lines.push(
				"Three things this can mean:",
				"1. The filter matched nothing. Property names are exact and the value shape depends on the property type.",
				`2. The data source is empty, or every row is archived${result.archivedCount ? ` (${result.archivedCount} archived row(s) were returned and not listed)` : ""}.`,
				`3. This token cannot see it: the source lives in the other workspace (retry with domain='${other}') or has not been shared with the ahKMS Notion integration (provider '${DOMAIN_PROVIDER[result.domain]}').`,
			);
		}
		lines.push("```json");
		lines.push(JSON.stringify({ rows: [], has_more: result.hasMore, next_cursor: result.nextCursor }));
		lines.push("```");
		return lines.join("\n");
	}

	const lines = [
		`Notion query: data source ${result.dataSourceId} in the '${result.domain}' workspace, ${result.rows.length} row(s)${result.filter ? ", filtered" : ""}${result.sorts?.length ? ", sorted" : ""}.`,
		...result.rows.map(renderRow),
	];
	if (result.hasMore && result.nextCursor) {
		lines.push(
			`More rows exist. Pass cursor '${result.nextCursor}' to fetch the next page; do not treat this list as complete.`,
		);
	}
	if (result.archivedCount > 0) {
		lines.push(`(${result.archivedCount} archived row(s) were returned by Notion and not listed.)`);
	}
	lines.push(
		`Pass a row id into notion_page_get({ domain: '${result.domain}', page_id }) to read its body, or into notion_page_update to patch its properties.`,
	);
	lines.push("```json");
	lines.push(JSON.stringify({ rows: result.rows, has_more: result.hasMore, next_cursor: result.nextCursor }));
	lines.push("```");
	return lines.join("\n");
}

export function createNotionDatabaseQueryAction(
	port: NotionPort,
): ActionDefinition<typeof queryNotionDatabaseInputSchema, NotionDatabaseQueryOutput> {
	return defineAction({
		id: "notion_database_query",
		name: "notion_database_query",
		description:
			"List a Notion database's rows with flattened property values — the list-shaped read, where " +
			"notion_search finds by title and notion_page_get reads one page. `domain` ('work' or " +
			"'angus') is REQUIRED, no default: separate integrations, each token seeing only its own " +
			"workspace. Cursor-paginated. Full notes: docs/guides/tools/notion_database_query.md",
		domain: "integrations",
		schema: queryNotionDatabaseInputSchema,
		outputSchema: notionDatabaseQueryOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp(result) {
			return formatNotionDatabaseQueryMcp(result);
		},
		async run(input: QueryNotionDatabaseInput, _context: ActionContext): Promise<NotionDatabaseQueryOutput> {
			if (!input.domain) {
				throw new Error(
					"`domain` is required to query a Notion database — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}
			if (!input.data_source_id) {
				throw new Error(
					"`data_source_id` is required: the id notion_config_get prints for a *_data_source_id key, or any 32-hex Notion data source id.",
				);
			}

			const domain = input.domain;
			const id = normalizeNotionId(input.data_source_id);
			const limit = input.limit ?? DEFAULT_LIMIT;

			let result: NotionQueryDataSourceResponse;
			try {
				result = await port.queryDataSource({
					workspace: domain,
					dataSourceId: id,
					pageSize: limit,
					cursor: input.cursor,
					filter: input.filter,
					sorts: input.sorts,
				});
			} catch (err) {
				if (isNotionNotFound(err)) {
					throw new Error(
						`${(err as Error).message}\n${crossWorkspaceHint(domain)}\nIf the id came from a *_database_id key it is the container, not the data source: use the matching *_data_source_id from notion_config_get.`,
					);
				}
				throw err;
			}

			const live = result.results.filter((p) => !p.archived);
			const archivedCount = result.results.length - live.length;
			const rows = live.map((p) => flattenRow(p, input.properties));

			return {
				domain,
				dataSourceId: id,
				rows,
				hasMore: result.has_more,
				nextCursor: result.next_cursor ?? null,
				archivedCount,
				filter: input.filter,
				sorts: input.sorts,
			};
		},
	});
}

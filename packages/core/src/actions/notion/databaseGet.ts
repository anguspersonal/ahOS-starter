import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type {
	NotionApiError,
	NotionDatabaseResponse,
	NotionDataSourceResponse,
	NotionPort,
} from "../../ports/notion.js";
import { normalizeNotionId } from "./pageGet.js";

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

export const notionDatabaseGetInputSchema = z.object({
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Which workspace: 'work' (work) or 'angus' (personal). Required, no default — each is a separate Notion integration and sees only its own databases.",
		),
	database_id: z
		.string()
		.optional()
		.describe("The database to introspect. Exactly one of database_id / data_source_id."),
	data_source_id: z
		.string()
		.optional()
		.describe(
			"A data source id; resolved to its parent database first. The *_data_source_id notion_config_get prints.",
		),
});

export type NotionDatabaseGetInput = z.infer<typeof notionDatabaseGetInputSchema>;

export const notionDatabasePropertySchema = z.object({
	name: z.string(),
	type: z.string(),
	options: z.array(z.string()).optional(),
});

export type NotionDatabaseProperty = z.infer<typeof notionDatabasePropertySchema>;

export const notionDatabaseGetOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	databaseId: z.string(),
	dataSourceId: z.string().optional(),
	properties: z.array(notionDatabasePropertySchema),
});

export type NotionDatabaseGetOutput = z.infer<typeof notionDatabaseGetOutputSchema>;

function hasProperties(
	raw: Record<string, unknown> | undefined,
): raw is NonNullable<NotionDatabaseResponse["properties"]> {
	return Boolean(raw && Object.keys(raw).length > 0);
}

export function formatNotionDatabaseGetMcp(result: NotionDatabaseGetOutput): string {
	const lines = [
		`Database schema (${result.domain}, db ${result.databaseId}):`,
		...result.properties.map((p) => {
			const options = p.options && p.options.length > 0 ? ` (options: ${p.options.join(", ")})` : "";
			return `  ${p.name} — ${p.type}${options}`;
		}),
	];
	return lines.join("\n");
}

export function createNotionDatabaseGetAction(
	port: NotionPort,
): ActionDefinition<typeof notionDatabaseGetInputSchema, NotionDatabaseGetOutput> {
	return defineAction({
		id: "notion_database_get",
		name: "notion_database_get",
		description:
			"Read a Notion database's schema: every property name, type, and the options of each " +
			"select, multi_select and status. This is how you find out what notion_page_create will " +
			"accept, for any database rather than only the tasks one.",
		domain: "integrations",
		schema: notionDatabaseGetInputSchema,
		outputSchema: notionDatabaseGetOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp(result) {
			return formatNotionDatabaseGetMcp(result);
		},
		async run(input: NotionDatabaseGetInput, _context: ActionContext): Promise<NotionDatabaseGetOutput> {
			if (!input.domain) {
				throw new Error(
					"`domain` is required to read a Notion database schema — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}

			const domain = input.domain;

			if (Boolean(input.database_id) === Boolean(input.data_source_id)) {
				throw new Error(
					"Pass exactly one of `database_id` or `data_source_id`. They are different ids for the same database under Notion's 2025-09-03 split, and guessing which one was meant is how the wrong destination gets read.",
				);
			}

			let databaseId: string;
			let dataSourceId: string | undefined;
			let rawProperties: NotionDatabaseResponse["properties"];

			if (input.data_source_id) {
				const dsId = normalizeNotionId(input.data_source_id);
				let ds: NotionDataSourceResponse;
				try {
					ds = await port.retrieveDataSource({
						workspace: domain,
						dataSourceId: dsId,
					});
				} catch (err) {
					if (isNotionNotFound(err)) {
						const message = err instanceof Error ? err.message : String(err);
						throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
					}
					throw err;
				}

				const parentDatabaseId = ds.parent?.database_id;
				if (!parentDatabaseId) {
					throw new Error(
						`Data source ${dsId} reports no parent database, so there is no id to create pages against. Pass \`database_id\` directly.`,
					);
				}
				databaseId = parentDatabaseId;

				let db: NotionDatabaseResponse;
				try {
					db = await port.retrieveDatabase({
						workspace: domain,
						databaseId,
					});
				} catch (err) {
					if (isNotionNotFound(err)) {
						const message = err instanceof Error ? err.message : String(err);
						throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
					}
					throw err;
				}

				if (hasProperties(ds.properties)) {
					rawProperties = ds.properties;
					dataSourceId = ds.id ?? dsId;
				} else if (hasProperties(db.properties)) {
					rawProperties = db.properties;
				} else {
					throw new Error(
						`Neither data source ${dsId} nor parent database ${databaseId} returned any properties.`,
					);
				}
			} else {
				databaseId = normalizeNotionId(input.database_id as string);
				let db: NotionDatabaseResponse;
				try {
					db = await port.retrieveDatabase({
						workspace: domain,
						databaseId,
					});
				} catch (err) {
					if (isNotionNotFound(err)) {
						const message = err instanceof Error ? err.message : String(err);
						throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
					}
					throw err;
				}

				const firstDsId = db.data_sources?.[0]?.id;
				if (hasProperties(db.properties) && !firstDsId) {
					rawProperties = db.properties;
				} else if (firstDsId) {
					let ds: NotionDataSourceResponse;
					try {
						ds = await port.retrieveDataSource({
							workspace: domain,
							dataSourceId: firstDsId,
						});
					} catch (err) {
						if (isNotionNotFound(err)) {
							const message = err instanceof Error ? err.message : String(err);
							throw new Error(`${message}\n${crossWorkspaceHint(domain)}`);
						}
						throw err;
					}
					if (hasProperties(ds.properties)) {
						rawProperties = ds.properties;
						dataSourceId = ds.id ?? firstDsId;
					} else if (hasProperties(db.properties)) {
						rawProperties = db.properties;
					} else {
						throw new Error(
							`Neither database ${databaseId} nor data source ${firstDsId} returned any properties.`,
						);
					}
				} else {
					throw new Error(
						`Database ${databaseId} returned neither properties nor data_sources.`,
					);
				}
			}

			const properties: NotionDatabaseProperty[] = Object.keys(rawProperties).map((name) => {
				const prop = rawProperties[name];
				const type = prop?.type ?? "unknown";
				const optionsHolder =
					type === "select"
						? prop?.select
						: type === "multi_select"
							? prop?.multi_select
							: type === "status"
								? prop?.status
								: undefined;
				const options = optionsHolder?.options?.map((o) => o.name).filter(Boolean);
				return {
					name,
					type,
					...(options && options.length > 0 ? { options } : {}),
				};
			});

			return {
				domain,
				databaseId,
				...(dataSourceId ? { dataSourceId } : {}),
				properties,
			};
		},
	});
}

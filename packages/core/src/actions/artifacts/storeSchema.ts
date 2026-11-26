import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type {
	OpenApiDoc,
	SchemaColumn,
	SchemaIntrospectionPort,
	SchemaTable,
} from "../../ports/schema.js";

/**
 * Turn one OpenAPI definition into a column list. Kept separate from the fetch so the
 * mapping (notably `required` → requiredOnInsert) is testable without a network stub.
 */
export function parseDefinition(
	name: string,
	definition: NonNullable<OpenApiDoc["definitions"]>[string],
): SchemaTable {
	const required = new Set(definition.required ?? []);
	const columns = Object.entries(definition.properties ?? {}).map(
		([columnName, property]): SchemaColumn => ({
			name: columnName,
			type: property.format ?? "unknown",
			jsonType: property.type ?? "unknown",
			requiredOnInsert: required.has(columnName),
			...(property.enum ? { enumValues: property.enum } : {}),
			...(property.description ? { description: property.description } : {}),
		}),
	);
	return { name, columns };
}

export function parseOpenApi(doc: OpenApiDoc): SchemaTable[] {
	return Object.entries(doc.definitions ?? {})
		.map(([name, definition]) => parseDefinition(name, definition))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export const describeSchemaInput = {
	table: z
		.string()
		.optional()
		.describe(
			"Table or view to describe, e.g. 'artifacts', 'entities', 'people'. Omitted, every table and view PostgREST exposes is listed by name with its column count — call again with one of those names for its columns. An unknown name is an error that lists what does exist rather than an empty result.",
		),
};

export const describeSchemaSchema = z.object(describeSchemaInput);

function renderColumn(column: SchemaColumn): string {
	const flags: string[] = [];
	if (column.requiredOnInsert) flags.push("required-on-insert");
	if (column.enumValues) flags.push(`enum: ${column.enumValues.join(" | ")}`);
	// PostgREST folds PK/FK markers and the column COMMENT into one description string;
	// newlines in it would break the one-line-per-column shape.
	if (column.description) flags.push(column.description.replace(/\s+/g, " ").trim());
	const suffix = flags.length ? `  [${flags.join("; ")}]` : "";
	return `  ${column.name}  ${column.type} (json: ${column.jsonType})${suffix}`;
}

export interface StoreSchemaOutput {
	data: { text: string };
	summary: string;
}

/**
 * Read the owner's own schema — "what columns does `artifacts` actually have?" (#480).
 *
 * Every other read tool returns a human-summarised PROJECTION (`project | Work AI`),
 * never a raw row, so an agent working through ahkms alone had no way to discover a
 * column short of the Supabase management API (which points at the wrong database as
 * easily as the right one) or `supabase/migrations/*.sql` (which has known drift). This
 * closes that: the answer comes from the live database, through the same credential the
 * rest of the server already uses.
 *
 * Read-only, and scoped by construction: PostgREST publishes only the schemas it is
 * configured to expose (`public`), so this cannot reach `auth`, `storage`, or any other
 * internal schema even though the credential could.
 *
 * One thing it deliberately does NOT report is nullability. PostgREST's `required` array
 * is "must be supplied on insert", which is NOT NULL *without a default*; a NOT NULL
 * `created_at timestamptz default now()` is absent from it. Reporting that as "nullable"
 * would be wrong for most of the columns anyone checks, so the flag is named for what it
 * actually means and the footer says so.
 */
export function createStoreSchemaAction(
	port: SchemaIntrospectionPort,
): ActionDefinition<typeof describeSchemaSchema, StoreSchemaOutput> {
	return defineAction({
		id: "store_schema",
		domain: "artifacts",
		description:
			"Describe the store's own columns — what fields artifacts, entities and people actually have. " +
			"Every other read tool returns a human-summarised projection, never a raw row, so this is the " +
			"only way to discover a column through ahkms. Reads the live database, so it cannot drift. Full " +
			"notes: docs/guides/tools/store_schema.md",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		schema: describeSchemaSchema,
		run: async (input) => {
			const tables = parseOpenApi(await port.fetchOpenApi());

			if (tables.length === 0) {
				throw new Error(
					"store_schema: PostgREST published no table definitions. That is a configuration answer, not an empty database — check that the 'public' schema is still exposed.",
				);
			}

			if (!input.table) {
				const text = [
					`${tables.length} table(s)/view(s) exposed by PostgREST on the 'public' schema:`,
					"",
					tables.map((t) => `  ${t.name}  (${t.columns.length} column(s))`).join("\n"),
					"",
					"Call again with `table` for a column list. Views appear here alongside tables and are not distinguished — PostgREST describes both the same way.",
					"",
					"```json",
					JSON.stringify(tables.map((t) => ({ name: t.name, columns: t.columns.length }))),
					"```",
				].join("\n");
				return {
					data: { text },
					summary: text,
				};
			}

			const table = tables.find((t) => t.name === input.table);
			if (!table) {
				throw new Error(
					`store_schema: no table or view named '${input.table}' is exposed. Available: ${tables.map((t) => t.name).join(", ")}.`,
				);
			}

			const text = [
				`${table.name} — ${table.columns.length} column(s), read live from PostgREST's schema description:`,
				"",
				table.columns.map(renderColumn).join("\n"),
				"",
				"'required-on-insert' means NOT NULL *and no default* — it is not nullability. A NOT NULL column with a default (an `id` with gen_random_uuid(), a `created_at` with now()) is NOT flagged, so absence of the flag never means the column accepts null.",
				"Types are the Postgres types. Note that numeric/bigint columns arrive over the wire as strings even though 'json: number' says otherwise.",
				"",
				"```json",
				JSON.stringify(table),
				"```",
			].join("\n");

			return {
				data: { text },
				summary: text,
			};
		},
		formatMcp: (result) => result.summary,
	});
}

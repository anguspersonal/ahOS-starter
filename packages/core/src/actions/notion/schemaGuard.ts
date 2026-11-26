import type { NotionDatabasePropertyItem, NotionPort } from "../../ports/notion.js";
import type { NotionDatabaseProperty } from "./databaseGet.js";

export type NotionDatabaseSchema = {
	properties: NotionDatabaseProperty[];
};

// Schema validation shared by every tool that writes a row into a Notion database
// (#1057). Extracted from daily_log_create, which had the only copy.
//
// It is shared rather than copied for the reason notionDomain.ts's header gives about
// the read/write token split: two validators under one intent drift, and the drift is
// invisible from either side. It matters more here than most places because of WHAT
// Notion does with a bad value. An unknown property name is a clean 400. An unknown
// `select` option is not — Notion CREATES the option and returns 200, so the row lands
// looking correct and the database quietly grows a near-duplicate of a real option
// ("Genral", "Weekly " with a trailing space). Nothing downstream reports that. So the
// check has to happen before the write, in the one place every writer goes through.
//
// `destination` names the thing being written to, so a caller's error reads as its own
// tool's ("for this Daily Log", "for this database") rather than a generic one.

/** Render a schema as `Name (type: a | b)` pairs, for listing valid choices in an error. */
export function describeProperties(schema: NotionDatabaseSchema): string {
	return schema.properties
		.map((p) => p.name + " (" + p.type + (p.options ? ": " + p.options.join(" | ") : "") + ")")
		.join(", ");
}

/**
 * The name of the database's title property. Every Notion database has exactly one, but
 * it is named by the user ("Name", "Task", "Meeting"), so it has to be discovered rather
 * than assumed — a caller passing a plain `title` string cannot know the key.
 */
export function resolveTitleProperty(schema: NotionDatabaseSchema, databaseId: string): string {
	const title = schema.properties.find((p) => p.type === "title");
	if (!title) {
		throw new Error(
			"Notion database " +
				databaseId +
				" reports no property of type 'title', which should be impossible for a database. Nothing was written.",
		);
	}
	return title.name;
}

/**
 * Every supplied property name exists in the schema, and none collides with one the
 * caller's tool writes itself. `reserved` maps a human label ("title", "date") to the
 * property name the tool fills from its own argument: two sources for one property
 * silently disagree, so it is refused rather than merged.
 */
export function assertPropertiesMatchSchema(
	properties: Record<string, unknown>,
	schema: NotionDatabaseSchema,
	options: { destination: string; reserved?: Record<string, string> },
): void {
	const supplied = Object.keys(properties);
	const reserved = options.reserved ?? {};
	const reservedNames = Object.values(reserved);

	const clashes = supplied.filter((n) => reservedNames.includes(n));
	if (clashes.length > 0) {
		const labelFor = (name: string) =>
			Object.keys(reserved).find((label) => reserved[label] === name) ?? name;
		throw new Error(
			"`properties` must not set " +
				clashes.map((n) => "'" + n + "'").join(", ") +
				" — this tool writes " +
				clashes.map((n) => "the " + labelFor(n) + " from `" + labelFor(n) + "`").join(" and ") +
				", so two sources for one property would silently disagree.",
		);
	}

	const valid = new Set(schema.properties.map((p) => p.name));
	const unknown = supplied.filter((n) => !valid.has(n));
	if (unknown.length > 0) {
		throw new Error(
			"Unknown propert" +
				(unknown.length === 1 ? "y" : "ies") +
				" for " +
				options.destination +
				": " +
				unknown.map((n) => "'" + n + "'").join(", ") +
				". Nothing was written. Valid properties are: " +
				describeProperties(schema),
		);
	}
}

/** The option names a caller supplied for one select-like property value. */
function suppliedOptionNames(value: unknown, type: string): string[] {
	if (!value || typeof value !== "object") return [];
	const holder = (value as Record<string, unknown>)[type];
	if (type === "multi_select") {
		if (!Array.isArray(holder)) return [];
		return holder
			.map((o) => (o && typeof o === "object" ? (o as { name?: unknown }).name : undefined))
			.filter((n): n is string => typeof n === "string");
	}
	if (holder && typeof holder === "object") {
		const name = (holder as { name?: unknown }).name;
		return typeof name === "string" ? [name] : [];
	}
	return [];
}

/**
 * Every select / multi_select / status value names an option the database already has.
 *
 * This is the check that earns the module. Notion answers an unknown option by adding
 * it, not by refusing, so the failure it prevents is a database that slowly accumulates
 * invented options — and the caller most likely to invent one is a model filling a
 * property from context rather than from the schema.
 */
export function assertOptionsMatchSchema(
	properties: Record<string, unknown>,
	schema: NotionDatabaseSchema,
	options: { destination: string },
): void {
	const byName = new Map(schema.properties.map((p) => [p.name, p]));
	const problems: string[] = [];

	for (const [propertyName, value] of Object.entries(properties)) {
		const declared = byName.get(propertyName);
		if (!declared || !declared.options) continue;
		const allowed = new Set(declared.options);
		const unknown = suppliedOptionNames(value, declared.type).filter((n) => !allowed.has(n));
		if (unknown.length > 0) {
			problems.push(
				"'" +
					propertyName +
					"' does not have option" +
					(unknown.length === 1 ? " " : "s ") +
					unknown.map((n) => "'" + n + "'").join(", ") +
					". Its options are: " +
					// Always non-empty here: the loop skips a property with no `options`, and
					// the schema flattener only attaches `options` when it has at least one.
					declared.options.join(" | "),
			);
		}
	}

	if (problems.length > 0) {
		throw new Error(
			"Unknown option value" +
				(problems.length === 1 ? "" : "s") +
				" for " +
				options.destination +
				". Nothing was written, and nothing was created: Notion would " +
				"have added the option rather than rejecting it. " +
				problems.join(" ") +
				". Never derive or invent an option value; read them from the config.",
		);
	}
}

// ── Where a database's properties actually live (#2285) ─────────────────────
//
// Under Notion-Version 2025-09-03, which the SDK this codebase uses defaults to, a
// database object no longer carries `properties`. It carries `data_sources`, and the
// properties live on the data source. A reader that takes `db.properties ?? {}` gets an
// empty schema and then reports, wrongly, that the database "has no title property".
// daily_log_create did exactly that from the day it moved onto the SDK, and wrote
// nothing for a week.
//
// So nobody reads `db.properties` directly. This is the one read, shared by every tool
// that needs a schema before it writes.

export type RawDatabaseProperties = Record<string, NotionDatabasePropertyItem>;

export type DatabasePropertiesReader = Pick<NotionPort, "retrieveDatabase"> &
	Partial<Pick<NotionPort, "retrieveDataSource">>;

export interface DatabasePropertiesRead {
	/** The raw properties, or null when neither the database nor its data source had any. */
	properties: RawDatabaseProperties | null;
	/** The data source consulted, when one was. */
	dataSourceId: string | null;
}

const hasAny = (raw: RawDatabaseProperties | undefined): raw is RawDatabaseProperties =>
	raw !== undefined && Object.keys(raw).length > 0;

/**
 * A database's raw properties: its own when the response carries them (older API
 * shape), otherwise its data source's. `dataSourceId` is the one the caller already
 * resolved from config, when it has one; failing that, the database's first.
 *
 * Returns `properties: null` rather than throwing when there are none anywhere, for
 * the readers that report on a schema instead of writing through it. Errors from
 * Notion itself (a 404, a timeout) are not caught: the caller owns how those read.
 */
export async function readDatabaseProperties(
	notion: DatabasePropertiesReader,
	params: { workspace: string; databaseId: string; dataSourceId?: string | null },
): Promise<DatabasePropertiesRead> {
	const db = await notion.retrieveDatabase({
		workspace: params.workspace,
		databaseId: params.databaseId,
	});
	if (hasAny(db.properties)) return { properties: db.properties, dataSourceId: null };

	const dataSourceId = params.dataSourceId || db.data_sources?.[0]?.id || null;
	if (!dataSourceId || typeof notion.retrieveDataSource !== "function") {
		return { properties: null, dataSourceId };
	}
	const ds = await notion.retrieveDataSource({ workspace: params.workspace, dataSourceId });
	return { properties: hasAny(ds.properties) ? ds.properties : null, dataSourceId };
}

/** Thrown when a database yields no properties from either place. Not a reachability
 *  problem, so callers that translate Notion 404s must let it through unchanged. */
export class DatabasePropertiesMissingError extends Error {
	constructor(databaseId: string, dataSourceId: string | null) {
		super(
			"Notion database " +
				databaseId +
				" returned no properties, and " +
				(dataSourceId
					? "neither did its data source " + dataSourceId
					: "it lists no data source to read them from") +
				". Without a schema the title and other properties cannot be addressed. Nothing was written.",
		);
		this.name = "DatabasePropertiesMissingError";
	}
}

/** `readDatabaseProperties` for a writer: no schema means no write. */
export async function requireDatabaseProperties(
	notion: DatabasePropertiesReader,
	params: { workspace: string; databaseId: string; dataSourceId?: string | null },
): Promise<RawDatabaseProperties> {
	const read = await readDatabaseProperties(notion, params);
	if (!read.properties) {
		throw new DatabasePropertiesMissingError(params.databaseId, read.dataSourceId);
	}
	return read.properties;
}

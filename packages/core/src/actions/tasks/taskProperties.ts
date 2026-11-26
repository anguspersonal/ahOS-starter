import {
	priorityLevelToNotionTier,
	type PriorityLevel,
} from "../../domain/priorityScale.js";
import type { NotionDatabaseProperty } from "../notion/databaseGet.js";

export type { NotionDatabaseProperty };

export type NotionDatabaseSchema = {
	properties: NotionDatabaseProperty[];
};

// Property passthrough (issue #145 gap 2): builds the Notion property VALUE shapes for
// task_create's optional `properties` bag, driven by the introspected database schema
// (issue #145 gap 3 / retrieveDatabaseSchema) rather than guessing the Notion type from
// the abstract name. This is the payoff of introspection: we know each property's real
// Notion type before building its value, so we can shape it correctly and validate
// select-like values against the DB's actual configured options up front — failing with
// a clear, actionable error instead of an opaque Notion 400.

export type RelationInput = { property: string; page_ids: string[] };

export type CreateTaskPropertiesInput = {
	status?: string;
	priority?: string;
	priority_tier?: 1 | 2 | 3;
	priority_level?: PriorityLevel;
	domain?: string;
	estimates?: string;
	type?: string[];
	tags?: string[];
	owner?: string;
	relation?: RelationInput;
	for_person?: RelationInput;
};

/**
 * Abstract property key -> fallback Notion property NAME, used only when the
 * integration's `property_map` has no entry for that key. This lets a caller start using
 * `properties` before wiring every key into property_map, as long as the tasks DB happens
 * to use these exact names; property_map always wins when present.
 *
 * Exported so tasksPropertyDrift.ts (#1001) can reconcile `property_map` against this same
 * set of abstract keys and their fallback names, rather than re-declaring the list — the
 * two must never drift apart, or the drift checker could pass a key create_task doesn't
 * know, or silently skip one it does.
 */
export const DEFAULT_PROPERTY_NAMES = {
	status: "Status",
	priority: "Priority",
	domain: "Domain",
	estimates: "Estimates",
	type: "Type",
	tags: "Tags",
	owner: "Owner",
	relation: "Relation",
	// `due` was the one abstract key with no fallback name, and createTask read it
	// straight off property_map rather than through this function. Both workspaces have
	// an empty property_map, so every due date ahKMS was ever given was discarded — the
	// call succeeded and said so only in prose (#817). Both target databases call the
	// property "Due date".
	due: "Due date",
	// `for_person` links a task to the person it is a promise/commitment to (#1028).
	for_person: "Person",
} as const satisfies Record<string, string>;

export function resolvePropertyName(
	abstractKey: string,
	propertyMap: Record<string, string>,
): string {
	// `DEFAULT_PROPERTY_NAMES` is `as const` so its own key union (TaskPropertyKey, in
	// tasksPropertyDrift.ts) is real rather than widening to `string`. This callsite is
	// generic over any abstract key a caller passes, most of which are NOT one of those
	// literal keys, so the lookup is intentionally by plain `string` — the `?? abstractKey`
	// fallback already handles a miss.
	const fallback = (DEFAULT_PROPERTY_NAMES as Record<string, string>)[abstractKey];
	return propertyMap[abstractKey] ?? fallback ?? abstractKey;
}

/**
 * Candidate values for the triage priority default (issue #298, from the ratified
 * capture-consolidation decision: "Priority=High unless inferable"), tried in order
 * against the tasks DB's actual configured options. The set and its order come from
 * ADR-040 §3's top priority tier — `Normalised Priority` treats High/P0/P1 as tier 1 —
 * so whichever vocabulary the DB uses ("High/Medium/Low" or the P0–P4 framework), the
 * default lands in the top tier and the task actually resurfaces instead of sinking.
 * "High" first (the May-12 default verbatim); then "P1" over "P0" because P0
 * conventionally means an emergency, which a default should never claim.
 */
export const DEFAULT_PRIORITY_CANDIDATES = ["High", "P1", "P0"] as const;

export type DefaultPriorityPick =
	| { applied: string }
	| { skipped: "property-missing" | "no-candidate-option" };

/**
 * Pick the triage default priority (issue #298) for a tasks DB, schema-aware so the
 * defaulted value is always one the DB actually accepts (never invents a select option —
 * Notion would silently create it and pollute the option vocabulary). Returns the first
 * DEFAULT_PRIORITY_CANDIDATES entry present in the priority property's options, or a
 * `skipped` reason when the property is missing/not select-like ("property-missing") or
 * none of the candidates are configured options ("no-candidate-option"). Never throws:
 * a defaulting miss must degrade to "no priority set", not block task creation.
 */
export function pickDefaultPriority(
	schemaProps: NotionDatabaseProperty[],
	propertyName: string,
): DefaultPriorityPick {
	const prop = schemaProps.find((p) => p.name === propertyName);
	if (!prop || (prop.type !== "select" && prop.type !== "status")) {
		return { skipped: "property-missing" };
	}
	const options = prop.options ?? [];
	const picked = DEFAULT_PRIORITY_CANDIDATES.find((c) => options.includes(c));
	return picked ? { applied: picked } : { skipped: "no-candidate-option" };
}

/**
 * Candidate option names for `properties.priority_tier` (issue #1920), keyed by tier 1–3
 * in resolution order. Numbered personal names come first so a database that carries both
 * "1 High" and a stray "High" resolves to "1 High"; P1 comes before P0 in tier 1 because
 * P0 conventionally means an emergency.
 */
export const PRIORITY_TIERS = {
	1: ["1 High", "High", "P1", "P0"],
	2: ["2 Medium", "Medium", "P2"],
	3: ["3 Low", "Low", "P3", "P4"],
} as const;

export type PriorityTier = keyof typeof PRIORITY_TIERS;

export type PriorityTierResolution =
	| { applied: string }
	| {
			skipped: "property-missing" | "no-tier-option";
			tried: string[];
			options: string[];
	  };

/**
 * Resolve `priority_tier` (1, 2 or 3) against a Tasks database's live Priority property
 * options. Returns `{ applied }` with the first candidate in `PRIORITY_TIERS[tier]` present
 * on a `select` or `status` property, or `{ skipped, tried, options }` when the property is
 * missing/not select-like or offers none of the tier's candidates.
 */
export function resolvePriorityTier(
	schemaProps: NotionDatabaseProperty[],
	propertyName: string,
	tier: PriorityTier,
): PriorityTierResolution {
	const tried = [...PRIORITY_TIERS[tier]];
	const prop = schemaProps.find((p) => p.name === propertyName);
	if (!prop || (prop.type !== "select" && prop.type !== "status")) {
		return { skipped: "property-missing", tried, options: [] };
	}
	const options = [...(prop.options ?? [])];
	const picked = tried.find((c) => options.includes(c));
	return picked ? { applied: picked } : { skipped: "no-tier-option", tried, options };
}

/**
 * Map a canonical 7-point priority level (1 Trivial lowest to 7 Critical highest; ADR-116, #1986)
 * onto the 3-tier Notion candidate bucket used by `resolvePriorityTier` (levels 5..7 -> tier 1 High,
 * levels 3..4 -> tier 2 Medium, levels 1..2 -> tier 3 Low).
 */
export function priorityLevelToLegacyTier(level: PriorityLevel): PriorityTier {
	return priorityLevelToNotionTier(level);
}

/**
 * Resolve `priority_level` (1..7, ADR-116) against a Tasks database's live Priority property
 * options. Delegates to `resolvePriorityTier` via `priorityLevelToLegacyTier(level)`.
 */
export function resolvePriorityLevel(
	schemaProps: NotionDatabaseProperty[],
	propertyName: string,
	level: PriorityLevel,
): PriorityTierResolution {
	return resolvePriorityTier(
		schemaProps,
		propertyName,
		priorityLevelToLegacyTier(level),
	);
}

/**
 * Render a list of live Notion property names for an "Available properties: …" message.
 * The ONE formatter for that phrase — tools/checkDosConfigDrift.ts (#1001) imports this
 * rather than re-joining `report.availableProperties` itself, so the drift report's
 * "Available properties" line and create_task's own error can never format that list
 * differently.
 */
export function formatAvailableProperties(names: string[]): string {
	return names.length > 0 ? names.join(", ") : "(none)";
}

function findSchemaProperty(
	schemaProps: NotionDatabaseProperty[],
	name: string,
): NotionDatabaseProperty {
	const found = schemaProps.find((p) => p.name === name);
	if (!found) {
		const available = formatAvailableProperties(schemaProps.map((p) => p.name));
		throw new Error(
			`task_create properties: Notion property '${name}' was not found on the tasks database. Available properties: ${available}.`,
		);
	}
	return found;
}

/**
 * Verify the tasks database really has the resolved `due` property and that it is a date.
 *
 * #817's rule, and the reason this raises rather than returning a flag: the old behaviour
 * noted a dropped due date in the response prose, which is easy to miss and impossible to
 * branch on, so nine tasks went out undated on 2026-08-09 before anyone noticed. A due
 * date that cannot be placed is a failed instruction, and it fails loudly — the same way
 * every other property already does via findSchemaProperty.
 */
export function assertDuePropertyUsable(
	schemaProps: NotionDatabaseProperty[],
	name: string,
	workspace: string,
): void {
	const found = schemaProps.find((p) => p.name === name);
	if (!found) {
		const dates = schemaProps.filter((p) => p.type === "date").map((p) => p.name);
		const suggestion = dates.length
			? `Date properties on it: ${dates.join(", ")}.`
			: "It has no date property at all.";
		throw new Error(
			`task_create: a due date was given, but the '${workspace}' tasks database has no property named '${name}'. ${suggestion} Set property_map.due on the '${workspace}' integration config to the right property name, or omit \`due\`.`,
		);
	}
	if (found.type !== "date") {
		throw new Error(
			`task_create: a due date was given, but '${name}' on the '${workspace}' tasks database is a ${found.type}, not a date. Set property_map.due to a date property, or omit \`due\`.`,
		);
	}
}

function assertValidOption(
	propertyName: string,
	prop: NotionDatabaseProperty,
	value: string,
): void {
	if (!prop.options || prop.options.length === 0) return;
	if (!prop.options.includes(value)) {
		throw new Error(
			`task_create properties: '${value}' is not a valid option for '${propertyName}' (${prop.type}). Valid options: ${prop.options.join(", ")}.`,
		);
	}
}

/**
 * Build the Notion value shape for a single select-like scalar (select/status/rich_text/
 * title-ish abstract fields — status, priority, domain, estimates). The shape keys off
 * `prop.type` as introspected from the live schema, not an assumption about which Notion
 * type the abstract field "should" be.
 */
function buildScalarValue(
	abstractKey: string,
	value: string,
	prop: NotionDatabaseProperty,
): unknown {
	switch (prop.type) {
		case "select":
			assertValidOption(prop.name, prop, value);
			return { select: { name: value } };
		case "status":
			assertValidOption(prop.name, prop, value);
			return { status: { name: value } };
		case "rich_text":
			return { rich_text: [{ type: "text", text: { content: value } }] };
		case "title":
			return { title: [{ type: "text", text: { content: value } }] };
		case "date":
			return { date: { start: value } };
		default:
			throw new Error(
				`task_create properties: Notion property '${prop.name}' has type '${prop.type}', which '${abstractKey}' does not know how to set. Supported types for a single-value field: select, status, rich_text, title, date.`,
			);
	}
}

function buildMultiSelectValue(
	abstractKey: string,
	values: string[],
	prop: NotionDatabaseProperty,
): unknown {
	if (prop.type !== "multi_select") {
		throw new Error(
			`task_create properties: Notion property '${prop.name}' has type '${prop.type}', but '${abstractKey}' expects a multi_select property.`,
		);
	}
	for (const v of values) assertValidOption(prop.name, prop, v);
	return { multi_select: values.map((name) => ({ name })) };
}

function buildPeopleValue(prop: NotionDatabaseProperty, personId: string): unknown {
	if (prop.type !== "people") {
		throw new Error(
			`task_create properties: Notion property '${prop.name}' has type '${prop.type}', but 'owner' expects a people property.`,
		);
	}
	return { people: [{ id: personId }] };
}

function buildRelationValue(prop: NotionDatabaseProperty, pageIds: string[]): unknown {
	if (prop.type !== "relation") {
		throw new Error(
			`task_create properties: Notion property '${prop.name}' has type '${prop.type}', but 'relation' expects a relation property.`,
		);
	}
	return { relation: pageIds.map((id) => ({ id })) };
}

/**
 * Resolve `properties` + owner-default into a Notion `{ [propertyName]: value }` object,
 * ready to merge into the page's properties. Only called when `properties` is non-empty
 * OR an owner default applies — the caller (createTask.ts) skips this entirely, and the
 * retrieveDatabaseSchema call it requires, on the fast path (no properties supplied and
 * no owner default available).
 */
export async function buildNotionProperties(opts: {
	tasksDatabaseId: string;
	propertyMap: Record<string, string>;
	properties: CreateTaskPropertiesInput;
	/** config.notion_user_id — used to default `owner` when the caller omits it. */
	defaultOwnerPersonId?: string;
	/**
	 * Pre-fetched database schema (issue #298: createTask.ts now introspects up front to
	 * pick the triage priority default). When supplied, skips the loadSchema
	 * call here so the request stays at one schema GET total.
	 */
	schema?: NotionDatabaseSchema;
	loadSchema?: (databaseId: string) => Promise<NotionDatabaseSchema>;
}): Promise<Record<string, unknown>> {
	const schema =
		opts.schema ??
		(opts.loadSchema
			? await opts.loadSchema(opts.tasksDatabaseId)
			: (() => {
					throw new Error("buildNotionProperties requires `schema` or `loadSchema`");
				})());
	const result: Record<string, unknown> = {};

	const scalarFields: Array<[key: keyof CreateTaskPropertiesInput, value: string | undefined]> = [
		["status", opts.properties.status],
		["priority", opts.properties.priority],
		["domain", opts.properties.domain],
		["estimates", opts.properties.estimates],
	];
	for (const [key, value] of scalarFields) {
		if (value === undefined) continue;
		const propName = resolvePropertyName(key, opts.propertyMap);
		const prop = findSchemaProperty(schema.properties, propName);
		result[propName] = buildScalarValue(key, value, prop);
	}

	const multiSelectFields: Array<[key: keyof CreateTaskPropertiesInput, value: string[] | undefined]> = [
		["type", opts.properties.type],
		["tags", opts.properties.tags],
	];
	for (const [key, values] of multiSelectFields) {
		if (values === undefined) continue;
		const propName = resolvePropertyName(key, opts.propertyMap);
		const prop = findSchemaProperty(schema.properties, propName);
		result[propName] = buildMultiSelectValue(key, values, prop);
	}

	// Owner: explicit value wins; otherwise default to the configured user
	// ("assign to me unless clearly someone else"), skipping entirely if the config has
	// no notion_user_id — never invent an owner.
	const ownerPersonId = opts.properties.owner ?? opts.defaultOwnerPersonId;
	if (ownerPersonId) {
		const propName = resolvePropertyName("owner", opts.propertyMap);
		const prop = findSchemaProperty(schema.properties, propName);
		result[propName] = buildPeopleValue(prop, ownerPersonId);
	}

	if (opts.properties.relation) {
		const propName = resolvePropertyName(
			opts.properties.relation.property,
			opts.propertyMap,
		);
		const prop = findSchemaProperty(schema.properties, propName);
		result[propName] = buildRelationValue(prop, opts.properties.relation.page_ids);
	}

	if (opts.properties.for_person) {
		const propName = resolvePropertyName(
			opts.properties.for_person.property,
			opts.propertyMap,
		);
		const prop = schema.properties.find(
			(p) => p.name.toLowerCase() === propName.toLowerCase() && p.type === "relation",
		);
		if (prop) {
			result[prop.name] = buildRelationValue(prop, opts.properties.for_person.page_ids);
		}
	}

	return result;
}

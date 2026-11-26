import type { NotionDatabaseSchema } from "../index.js";

// Reconcile a domain's tasks-integration `property_map` against a live read of its Tasks
// database (#1001). Sibling of dosConfigDrift.ts's Daily Log vocabulary reconciliation —
// same "config ⊆ notion" direction, same severity vocabulary — but for the OTHER writer:
// `create_task` is the sole Tasks DB writer (ADR-038 §5), and until this module nothing
// checked its `property_map` before the first write attempted it. #1001's observed case:
// `property_map: {}` on `notion_personal` was only discovered when four `create_task`
// calls all failed with "Notion property 'Owner' was not found on the tasks database" —
// this module lets tools/checkDosConfigDrift.ts surface that in the preamble instead.
//
// THE ABSTRACT KEY SET IS create_task's OWN, KEPT IN CORE
// `DEFAULT_PROPERTY_NAMES` lists which abstract keys `create_task` understands and what
// each falls back to when unmapped. Defined here in the contracts layer so `domain/` does
// not import upwards from `actions/tasks/taskProperties.ts` (ADR-101).
//
// NOTHING HERE FAILS A RUN. This module returns findings; the caller (checkDosConfigDrift)
// decides what a finding means for a running ritual — see that file's severity ladder.

const DEFAULT_PROPERTY_NAMES = {
	status: "Status",
	priority: "Priority",
	domain: "Domain",
	estimates: "Estimates",
	type: "Type",
	tags: "Tags",
	owner: "Owner",
	relation: "Relation",
	due: "Due date",
	for_person: "Person",
} as const satisfies Record<string, string>;

export type TaskPropertyKey = keyof typeof DEFAULT_PROPERTY_NAMES;

export const TASK_PROPERTY_KEYS = Object.keys(DEFAULT_PROPERTY_NAMES) as TaskPropertyKey[];

/**
 * What became of one abstract key.
 *
 *   mapped_ok          property_map names a property, and it exists on the live database.
 *   mapped_missing     property_map names a property that does NOT exist on the live
 *                       database — create_task will throw on the first write that uses
 *                       this key (createTaskProperties.ts's findSchemaProperty). A fault.
 *   unmapped_available  the key has no property_map entry, but the database happens to
 *                       have a property under create_task's fallback name for it.
 *                       Informational — not every abstract key needs a mapping, since
 *                       create_task's fallback would already resolve it.
 *
 * A key that is both unmapped AND has no matching fallback property is not reported at
 * all: nothing is configured and nothing on the database corresponds to it, so there is
 * nothing to say.
 */
export type TaskPropertyStatus = "mapped_ok" | "mapped_missing" | "unmapped_available";

export type TaskPropertyFinding = {
	abstractKey: TaskPropertyKey;
	/** The mapped Notion property name, or `null` when this key is unmapped. */
	mappedName: string | null;
	status: TaskPropertyStatus;
};

/**
 * Reconcile one workspace's `property_map` against its live Tasks database schema.
 *
 * Pure: both inputs are supplied, nothing is read or written, and the same pair always
 * produces the same findings. The I/O — loading the integration config, reading the live
 * schema, and deciding what a finding means for a running ritual — belongs to the caller
 * (tools/checkDosConfigDrift.ts).
 */
export function reconcileTasksPropertyMap(
	propertyMap: Record<string, string>,
	live: NotionDatabaseSchema,
): TaskPropertyFinding[] {
	const liveNames = new Set(live.properties.map((p) => p.name));
	const findings: TaskPropertyFinding[] = [];

	for (const key of TASK_PROPERTY_KEYS) {
		const mapped = propertyMap[key];
		if (mapped) {
			findings.push({
				abstractKey: key,
				mappedName: mapped,
				status: liveNames.has(mapped) ? "mapped_ok" : "mapped_missing",
			});
			continue;
		}

		const fallback = DEFAULT_PROPERTY_NAMES[key];
		if (fallback && liveNames.has(fallback)) {
			findings.push({ abstractKey: key, mappedName: null, status: "unmapped_available" });
		}
	}

	return findings;
}

/** True when at least one mapped abstract key points at a property the database lacks. */
export function hasTasksPropertyDrift(findings: TaskPropertyFinding[]): boolean {
	return findings.some((f) => f.status === "mapped_missing");
}

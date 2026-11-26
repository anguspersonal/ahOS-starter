import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { actionConfidenceSchema } from "../types.js";
import {
	TASK_EFFORT_SLUGS,
	TASK_ENERGY_MODE_SLUGS,
	TASK_SOURCE_SLUGS,
	TASK_STATUS_SLUGS,
	TASK_TYPE_SLUGS,
} from "../../domain/taskDimensions.js";

/**
 * Standard fields for task records in ahOS (ADR-100, ADR-116, ADR-117).
 */
export const taskFields = {
	title: z.string().min(1).describe("Task title."),
	description: z.string().nullable().optional().describe("Task description."),
	status: z
		.enum(TASK_STATUS_SLUGS)
		.optional()
		.describe(
			"Task lifecycle status slug (proposed, someday, todo, in_progress, blocked, done, cancelled; default: todo; ADR-117).",
		),
	priority: z
		.enum(["low", "medium", "high", "urgent"])
		.optional()
		.describe("Task priority level."),
	priority_level: z
		.number()
		.int()
		.min(1)
		.max(7)
		.optional()
		.describe(
			"Canonical 7-point task priority level (1 = Trivial lowest to 7 = Critical highest; ADR-116).",
		),
	task_type: z
		.enum(TASK_TYPE_SLUGS)
		.optional()
		.describe(
			"Canonical task cadence and type slug (one_off, recurring, habit, milestone; default: one_off; ADR-117).",
		),
	recurrence_rule: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Optional schedule or RRULE string when task_type is recurring or habit (ADR-117).",
		),
	effort: z
		.enum(TASK_EFFORT_SLUGS)
		.nullable()
		.optional()
		.describe(
			"Optional execution effort size slug (quick, small, medium, large; ADR-117).",
		),
	energy_mode: z
		.enum(TASK_ENERGY_MODE_SLUGS)
		.nullable()
		.optional()
		.describe(
			"Optional execution or cognitive mode slug (deep_work, admin, waiting_on, quick_win; ADR-117).",
		),
	source: z
		.enum(TASK_SOURCE_SLUGS)
		.nullable()
		.optional()
		.describe(
			"Optional provenance slug recording how the task entered ahOS (owner, agent_proposed, email_triage, meeting_sweep, ritual; ADR-117).",
		),
	due_date: z.string().datetime().nullable().optional().describe("Task due date in ISO 8601 format."),
	due_time: z.string().nullable().optional().describe("Optional time of day (HH:mm:ss)."),
	duration_minutes: z.number().int().min(1).optional().describe("Estimated task duration in minutes."),
	tags: z.array(z.string()).nullable().optional().describe("Tags associated with the task."),
	notes: z.string().nullable().optional().describe("Additional task notes."),
	entity_id: z.string().uuid().nullable().optional().describe("Related knowledge graph entity ID."),
	source_artifact_id: z.string().uuid().nullable().optional().describe("Source artifact ID."),
	team_id: z.string().uuid().nullable().optional().describe("Team ID."),
};

export const taskCrudSchema = z.object({
	operation: z
		.enum(["query", "get", "create", "update", "complete", "delete", "bulk_delete"])
		.describe("The task management operation to perform."),
	id: z.string().uuid().optional().describe("Task ID for get, update, complete, or delete."),
	ids: z.array(z.string().uuid()).optional().describe("Task IDs for bulk_delete."),
	title: z.string().min(1).optional().describe("Task title when creating."),
	description: z.string().nullable().optional().describe("Task description."),
	status: z
		.enum(TASK_STATUS_SLUGS)
		.optional()
		.describe(
			"Task lifecycle status filter or value (proposed, someday, todo, in_progress, blocked, done, cancelled; ADR-117).",
		),
	priority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("Task priority filter or value."),
	priority_level: z
		.number()
		.int()
		.min(1)
		.max(7)
		.optional()
		.describe(
			"Canonical 7-point task priority level filter or value (1 = Trivial lowest to 7 = Critical highest; ADR-116).",
		),
	task_type: z
		.enum(TASK_TYPE_SLUGS)
		.optional()
		.describe(
			"Task cadence and type filter or value (one_off, recurring, habit, milestone; ADR-117).",
		),
	recurrence_rule: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Optional schedule or RRULE string when task_type is recurring or habit (ADR-117).",
		),
	effort: z
		.enum(TASK_EFFORT_SLUGS)
		.nullable()
		.optional()
		.describe(
			"Execution effort size filter or value (quick, small, medium, large; ADR-117).",
		),
	energy_mode: z
		.enum(TASK_ENERGY_MODE_SLUGS)
		.nullable()
		.optional()
		.describe(
			"Execution or cognitive mode filter or value (deep_work, admin, waiting_on, quick_win; ADR-117).",
		),
	source: z
		.enum(TASK_SOURCE_SLUGS)
		.nullable()
		.optional()
		.describe(
			"Provenance filter or value (owner, agent_proposed, email_triage, meeting_sweep, ritual; ADR-117).",
		),
	due_date: z.string().datetime().nullable().optional().describe("Due date in ISO 8601."),
	due_before: z.string().datetime().optional().describe("Filter tasks due before this timestamp."),
	due_after: z.string().datetime().optional().describe("Filter tasks due after this timestamp."),
	tags: z.array(z.string()).optional().describe("Tags filter or payload."),
	entity_id: z.string().uuid().nullable().optional().describe("Related entity ID."),
	query: z.string().optional().describe("Search term matching task title or notes."),
	patch: z.object(taskFields).partial().optional().describe("Fields to update during an update operation."),
	limit: z.number().int().min(1).max(100).optional().describe("Maximum results to return (default: 20)."),
});

export type TaskCrudInput = z.infer<typeof taskCrudSchema>;

export interface UserTaskRow {
	id: string;
	title: string;
	description: string | null;
	status: string;
	priority: string | null;
	priority_level: number | null;
	task_type?: string;
	recurrence_rule?: string | null;
	effort?: string | null;
	energy_mode?: string | null;
	source?: string | null;
	due_date: string | null;
	completed_at: string | null;
	assigned_to: string | null;
	created_by: string | null;
	created_via: string | null;
	confidence_score: number | null;
	tags: string[] | null;
	notes: string | null;
	entity_id: string | null;
	source_artifact_id: string | null;
	due_time: string | null;
	duration_minutes: number | null;
	team_id: string | null;
	created_at: string;
	updated_at: string;
	user_id: string;
}

export interface TaskCrudResult {
	operation: string;
	count?: number;
	tasks?: UserTaskRow[];
	task?: UserTaskRow;
	deleted_count?: number;
	ids?: string[];
}

export const createTaskInput = {
	// `.optional()` at the zod layer, required by requireWorkspace in the handler — the
	// updateStateDoc convention, so an omitted value gets a teaching error naming both
	// accepted values rather than the SDK's bare "Required", and a handler called
	// directly (unit tests, in-process callers) is held to the same rule as an MCP client.
	// Required in fact, optional at the zod layer — see the note above, and #1062,
	// which added `domain` as the one identity axis. Either argument satisfies the
	// requirement; requireWorkspace refuses when neither is given.
	domain: optionalDomainInput,
	workspace: z
		.enum(["notion_work", "notion_personal"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'). Which Notion workspace's tasks database to write to: 'notion_work' or 'notion_personal'.",
		),
	title: z.string().min(1).describe("The task title."),
	notes: z
		.string()
		.optional()
		.describe("Optional details, added as the task's body."),
	due: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional due date (YYYY-MM-DD). Only applied if a 'due' property is mapped in the Notion integration config. " +
				"Triage default (issue #298): when omitted and a 'due' property IS mapped, defaults to tomorrow — pass an explicit date (stated or inferred from the request) to override; the response says when the default was applied.",
		),
	for_person_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Optional person entity id (from entities/people) representing the person this task is a promise or commitment to (#1028). " +
				"Writes the Notion relation to the person's page where the target database has one (or via property_map.for_person), " +
				"and always records an artifact_entity_links row linking the task's source artifact to this person with link_type 'related' and notes 'promise_to' so the graph knows.",
		),
	artifact_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Optional id of the artifact this task came from (e.g. a meeting transcript). Records cross-store lineage so the task is traceable from the knowledge side. When omitted, the task's source is auto-captured from `source_text` (or the title) instead — see `source_text`.",
		),
	source_text: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The message that requested this task, used ONLY when no `artifact_id` is given. It is captured as the task's source artifact so every task is traceable back to the thought that produced it (issue #413) — the request itself IS the source. Pass the user's actual request verbatim (e.g. 'add a task to call the dentist tomorrow'); if omitted, the title stands in as a thin fallback. The captured artifact carries distinct provenance (content_subtype='task_request') and is excluded from knowledge_search by default, so one-line task requests don't crowd search. Ignored when `artifact_id` is supplied (the task already has a source).",
		),
	single_task: z
		.boolean()
		.optional()
		.describe(
			"Set true when this atom declares exactly ONE task (the common 1:1 case — e.g. a later Act pass, such as EOD synthesis, re-visiting an atom eager Act may already have created a task from). " +
				"When true and artifact_id is given, skips creation if ANY kind='task' link already exists for that artifact — prevents eager-Act-at-capture plus a later Act pass from double-creating. " +
				"Leave false/omitted for the 1:N case (an atom that spawns several distinct tasks); use dedup_key instead to dedup those individually. " +
				"WARNING: this is a caller-asserted contract, not a structural one — nothing stops you from passing single_task=true on an atom that actually has several distinct tasks. Doing so SILENTLY SKIPS every task after the first (only the response text says so; there is no error). If an atom might spawn more than one task, use dedup_key instead, per-task.",
		),
	dedup_key: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Stable per-task idempotency key for the 1:N case (e.g. a slug of this specific task's title, when one atom spawns several tasks). " +
				"When given with artifact_id, skips creation if a kind='task' link with this exact dedup_key already exists for that artifact; otherwise creates and records it under this key. " +
				"Mutually exclusive in practice with single_task (single_task is for the 1:1 case; dedup_key is for 1:N).",
		),
	skip_notion_dedup: z
		.boolean()
		.optional()
		.describe(
			"Opt out of the Tasks-DB duplicate guard (issue #734). By default (false/omitted) task_create reads the target " +
				"Tasks database itself — the system of record — for an OPEN task whose title matches this one (exact, case-insensitive, " +
				"trimmed) or whose configured relation property already points at the same source page (properties.relation, when given). " +
				"A match is reported as a duplicate and NOTHING is created, unlike single_task/dedup_key (which only guard against the " +
				"lineage ledger, `artifact_external_links` — a check that misses a task entered straight into Notion, or an ambiguous " +
				"Notion failure that actually landed a page; see ADR-040's erratum, #413). Pass true when you deliberately want a second " +
				"task despite a same-titled one existing (e.g. a genuinely recurring task) — this also skips the extra Notion read the " +
				"guard costs, so the unguarded fast path pays nothing for it.",
		),
	properties: z
		.object({
			status: z
				.string()
				.optional()
				.describe(
					"Task status (single-select or Notion 'status' type — e.g. 'Not started', 'In progress', 'Done'). Mapped via the integration's property_map (abstract key 'status'); the value must be one of the target property's configured options — an invalid option throws an error listing the valid ones.",
				),
			priority: z
				.string()
				.optional()
				.describe(
					"Task priority (single-select — e.g. 'Low', 'High'). Mapped via property_map's 'priority' key; value must match one of the configured options. " +
						"Triage default (issue #298): when omitted, defaults to the top priority tier (first of 'High'/'P1'/'P0' the DB accepts, per ADR-040 §3) — pass an explicit value (stated or inferred from the request) to override; the response says when the default was applied.",
				),
			priority_tier: z
				.literal([1, 2, 3])
				.optional()
				.describe(
					"Normalized priority tier (1, 2 or 3, where 1 is the top tier per ADR-040 §3's Normalised Priority). Resolved against the target Tasks database's live Priority options (tier 1 tries '1 High', 'High', 'P1', 'P0'; tier 2 tries '2 Medium', 'Medium', 'P2'; tier 3 tries '3 Low', 'Low', 'P3', 'P4'); refuses before any write if no option matches. Cannot be combined with properties.priority.",
				),
			priority_level: z
				.number()
				.int()
				.min(1)
				.max(7)
				.optional()
				.describe(
					"Canonical 7-point task priority level (1 = Trivial lowest to 7 = Critical highest; ADR-116). Resolved against the target Tasks database's live Priority options (levels 5..7 resolve to High tier options; levels 3..4 resolve to Medium tier options; levels 1..2 resolve to Low tier options). Cannot be combined with properties.priority or properties.priority_tier.",
				),
			domain: z
				.string()
				.optional()
				.describe(
					"Task domain/area (single-select — e.g. 'Product and Engineering'). Mapped via property_map's 'domain' key; value must match one of the configured options.",
				),
			estimates: z
				.string()
				.optional()
				.describe(
					"Size/effort estimate (single-select — e.g. 'S', 'M', 'L'). Mapped via property_map's 'estimates' key; value must match one of the configured options.",
				),
			type: z
				.array(z.string())
				.optional()
				.describe(
					"Task type(s) (multi-select — e.g. ['Task', 'Polish']). Mapped via property_map's 'type' key; every value must match one of the configured options.",
				),
			tags: z
				.array(z.string())
				.optional()
				.describe(
					"Free-form tags (multi-select — e.g. ['launch-v1.0.0', 'Mobile']). Mapped via property_map's 'tags' key; every value must match one of the configured options.",
				),
			owner: z
				.string()
				.optional()
				.describe(
					"Notion person id to set as the task owner (people property, mapped via property_map's 'owner' key). If omitted, defaults to the integration config's notion_user_id ('assign to me unless clearly someone else') when that config value is set; if the config has no notion_user_id, owner is left unset rather than invented.",
				),
			relation: z
				.object({
					property: z
						.string()
						.min(1)
						.describe(
							"Abstract property key to map via property_map (e.g. 'relation') to the Notion relation property's NAME on the tasks database.",
						),
					page_ids: z
						.array(z.string().min(1))
						.min(1)
						.describe(
							"Notion page id(s) to link, e.g. the source meeting note. These are Notion page ids the caller already has — this tool does not resolve artifact_id to a Notion page id.",
						),
				})
				.optional()
				.describe(
					"Link this task back to a source Notion page (e.g. a meeting note) via a relation property. The property NAME is resolved through property_map using relation.property as the abstract key; the value(s) are page ids you already have.",
				),
		})
		.strict()
		.refine((p) => !(p.priority !== undefined && p.priority_tier !== undefined), {
			message: "pass properties.priority or properties.priority_tier, not both",
		})
		.refine(
			(p) =>
				!(
					p.priority_level !== undefined &&
					(p.priority !== undefined || p.priority_tier !== undefined)
				),
			{
				message:
					"pass properties.priority_level, properties.priority, or properties.priority_tier, not more than one",
			},
		)
		.optional()
		.describe(
			"Rich Notion properties beyond title/due/notes (issue #145 gap 2). Each field maps through the integration's property_map (abstract name -> Notion property NAME) and is validated against the target database's actual schema via introspection (retrieve_database_schema) — an unmapped or nonexistent property, or an invalid select/multi_select/status option, throws a clear error rather than an opaque Notion 400. Omit entirely to skip the extra schema-introspection API call (fast path, unchanged from before this field existed).",
		),
	confidence: actionConfidenceSchema,
};

export const createTaskSchema = z.object(createTaskInput);

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type CreateTaskProperties = NonNullable<CreateTaskInput["properties"]>;

export interface CreateTaskResult {
	status: "created" | "skipped_duplicate" | "interrupted_claim";
	title: string;
	pageId?: string;
	pageUrl?: string;
	deduplicated: boolean;
	message: string;
}

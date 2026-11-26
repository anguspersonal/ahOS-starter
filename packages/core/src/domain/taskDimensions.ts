// Orthogonal Task and Actionable-Entity Dimensions Contract (ADR-117, #2074).
// Isomorphic and browser-safe: zero Node imports.

import { isPriorityLevel, type PriorityLevel } from "./priorityScale.js";

export interface DimensionTerm<TSlug extends string = string> {
	id: number;
	slug: TSlug;
	display: string;
	meaning: string;
}

// ---------------------------------------------------------------------------
// 1. Lifecycle Status (1..7, default 'todo')
// ---------------------------------------------------------------------------

export const TASK_STATUS_SLUGS = [
	"proposed",
	"someday",
	"todo",
	"in_progress",
	"blocked",
	"done",
	"cancelled",
] as const;
export type TaskStatusSlug = (typeof TASK_STATUS_SLUGS)[number];

export const DEFAULT_TASK_STATUS: TaskStatusSlug = "todo";

export const TASK_STATUS_TERMS: readonly DimensionTerm<TaskStatusSlug>[] = [
	{
		id: 1,
		slug: "proposed",
		display: "Proposed",
		meaning:
			"Not confirmed it will or should be done yet; needs owner decision before promoting to To Do.",
	},
	{
		id: 2,
		slug: "someday",
		display: "Someday",
		meaning:
			"Worth keeping on the radar, but intentionally parked with no active commitment or timeline.",
	},
	{
		id: 3,
		slug: "todo",
		display: "To Do",
		meaning:
			"Confirmed commitment queued for execution, not yet started.",
	},
	{
		id: 4,
		slug: "in_progress",
		display: "In Progress",
		meaning: "Actively being worked on right now.",
	},
	{
		id: 5,
		slug: "blocked",
		display: "Blocked",
		meaning:
			"Committed work that cannot advance until an external dependency, reply, or prerequisite resolves.",
	},
	{
		id: 6,
		slug: "done",
		display: "Done",
		meaning: "Completed and verified; no further action required.",
	},
	{
		id: 7,
		slug: "cancelled",
		display: "Cancelled",
		meaning:
			"Explicitly dropped or superseded; kept for lineage so agents do not re-propose it.",
	},
] as const;

export function isTaskStatusSlug(value: unknown): value is TaskStatusSlug {
	return (
		typeof value === "string" &&
		(TASK_STATUS_SLUGS as readonly string[]).includes(value)
	);
}

export function getTaskStatusTerm(
	slug: TaskStatusSlug,
): DimensionTerm<TaskStatusSlug> {
	const found = TASK_STATUS_TERMS.find((t) => t.slug === slug);
	if (!found) {
		throw new Error(`Invalid task status slug: ${String(slug)}`);
	}
	return found;
}

// ---------------------------------------------------------------------------
// 2. Cadence / Task Type (1..4, default 'one_off')
// ---------------------------------------------------------------------------

export const TASK_TYPE_SLUGS = [
	"one_off",
	"recurring",
	"habit",
	"milestone",
] as const;
export type TaskTypeSlug = (typeof TASK_TYPE_SLUGS)[number];

export const DEFAULT_TASK_TYPE: TaskTypeSlug = "one_off";

export const TASK_TYPE_TERMS: readonly DimensionTerm<TaskTypeSlug>[] = [
	{
		id: 1,
		slug: "one_off",
		display: "One-Off",
		meaning: "Single deliverable that completes once and does not repeat.",
	},
	{
		id: 2,
		slug: "recurring",
		display: "Recurring",
		meaning:
			"Routine operational commitment that repeats on a defined schedule or recurrence rule.",
	},
	{
		id: 3,
		slug: "habit",
		display: "Habit",
		meaning:
			"Ongoing behavioural practice or cadence tracked for consistency.",
	},
	{
		id: 4,
		slug: "milestone",
		display: "Milestone",
		meaning:
			"Key checkpoint or target marker anchoring a broader project or arrangement.",
	},
] as const;

export function isTaskTypeSlug(value: unknown): value is TaskTypeSlug {
	return (
		typeof value === "string" &&
		(TASK_TYPE_SLUGS as readonly string[]).includes(value)
	);
}

export function getTaskTypeTerm(
	slug: TaskTypeSlug,
): DimensionTerm<TaskTypeSlug> {
	const found = TASK_TYPE_TERMS.find((t) => t.slug === slug);
	if (!found) {
		throw new Error(`Invalid task type slug: ${String(slug)}`);
	}
	return found;
}

// ---------------------------------------------------------------------------
// 3. Effort / Size (1..4, nullable)
// ---------------------------------------------------------------------------

export const TASK_EFFORT_SLUGS = [
	"quick",
	"small",
	"medium",
	"large",
] as const;
export type TaskEffortSlug = (typeof TASK_EFFORT_SLUGS)[number];

export const TASK_EFFORT_TERMS: readonly DimensionTerm<TaskEffortSlug>[] = [
	{
		id: 1,
		slug: "quick",
		display: "Quick (<15m)",
		meaning:
			"Under 15 minutes of effort; trivial execution cost regardless of priority level.",
	},
	{
		id: 2,
		slug: "small",
		display: "Small",
		meaning: "Focused work block of roughly 15 to 60 minutes.",
	},
	{
		id: 3,
		slug: "medium",
		display: "Medium",
		meaning:
			"Half-day or multi-hour effort requiring a dedicated session.",
	},
	{
		id: 4,
		slug: "large",
		display: "Large",
		meaning:
			"Multi-day effort that should usually be broken down into smaller tasks.",
	},
] as const;

export function isTaskEffortSlug(value: unknown): value is TaskEffortSlug {
	return (
		typeof value === "string" &&
		(TASK_EFFORT_SLUGS as readonly string[]).includes(value)
	);
}

export function getTaskEffortTerm(
	slug: TaskEffortSlug,
): DimensionTerm<TaskEffortSlug> {
	const found = TASK_EFFORT_TERMS.find((t) => t.slug === slug);
	if (!found) {
		throw new Error(`Invalid task effort slug: ${String(slug)}`);
	}
	return found;
}

// ---------------------------------------------------------------------------
// 4. Execution / Energy Mode (1..4, nullable)
// ---------------------------------------------------------------------------

export const TASK_ENERGY_MODE_SLUGS = [
	"deep_work",
	"admin",
	"waiting_on",
	"quick_win",
] as const;
export type TaskEnergyModeSlug = (typeof TASK_ENERGY_MODE_SLUGS)[number];

export const TASK_ENERGY_MODE_TERMS: readonly DimensionTerm<TaskEnergyModeSlug>[] =
	[
		{
			id: 1,
			slug: "deep_work",
			display: "Deep Work",
			meaning:
				"High-focus cognitive work requiring uninterrupted concentration.",
		},
		{
			id: 2,
			slug: "admin",
			display: "Admin",
			meaning:
				"Low-friction operational, logistical, or coordination work.",
		},
		{
			id: 3,
			slug: "waiting_on",
			display: "Waiting On",
			meaning: "Delegated or external action being tracked for follow-up.",
		},
		{
			id: 4,
			slug: "quick_win",
			display: "Quick Win",
			meaning:
				"Fast momentum builder suitable for low-energy or between-meeting slots.",
		},
	] as const;

export function isTaskEnergyModeSlug(
	value: unknown,
): value is TaskEnergyModeSlug {
	return (
		typeof value === "string" &&
		(TASK_ENERGY_MODE_SLUGS as readonly string[]).includes(value)
	);
}

export function getTaskEnergyModeTerm(
	slug: TaskEnergyModeSlug,
): DimensionTerm<TaskEnergyModeSlug> {
	const found = TASK_ENERGY_MODE_TERMS.find((t) => t.slug === slug);
	if (!found) {
		throw new Error(`Invalid task energy mode slug: ${String(slug)}`);
	}
	return found;
}

// ---------------------------------------------------------------------------
// 5. Provenance / Source (1..5, nullable)
// ---------------------------------------------------------------------------

export const TASK_SOURCE_SLUGS = [
	"owner",
	"agent_proposed",
	"email_triage",
	"meeting_sweep",
	"ritual",
] as const;
export type TaskSourceSlug = (typeof TASK_SOURCE_SLUGS)[number];

export const TASK_SOURCE_TERMS: readonly DimensionTerm<TaskSourceSlug>[] = [
	{
		id: 1,
		slug: "owner",
		display: "Owner",
		meaning: "Created or requested directly by Angus.",
	},
	{
		id: 2,
		slug: "agent_proposed",
		display: "Agent Proposed",
		meaning:
			"Suggested autonomously by an agent and awaiting owner commitment.",
	},
	{
		id: 3,
		slug: "email_triage",
		display: "Email Triage",
		meaning: "Extracted from inbound or outbound email triage.",
	},
	{
		id: 4,
		slug: "meeting_sweep",
		display: "Meeting Sweep",
		meaning:
			"Extracted from meeting notes, transcripts, or call summaries.",
	},
	{
		id: 5,
		slug: "ritual",
		display: "Ritual",
		meaning: "Surfaced during a prep, sync, or reflect ritual pass.",
	},
] as const;

export function isTaskSourceSlug(value: unknown): value is TaskSourceSlug {
	return (
		typeof value === "string" &&
		(TASK_SOURCE_SLUGS as readonly string[]).includes(value)
	);
}

export function getTaskSourceTerm(
	slug: TaskSourceSlug,
): DimensionTerm<TaskSourceSlug> {
	const found = TASK_SOURCE_TERMS.find((t) => t.slug === slug);
	if (!found) {
		throw new Error(`Invalid task source slug: ${String(slug)}`);
	}
	return found;
}

// ---------------------------------------------------------------------------
// 6. Actionable Entity Types & Properties Validation (ADR-117 §3)
// ---------------------------------------------------------------------------

export const ACTIONABLE_ENTITY_TYPES = [
	"project",
	"arrangement",
	"decision",
	"event",
] as const;
export type ActionableEntityType = (typeof ACTIONABLE_ENTITY_TYPES)[number];

export function isActionableEntityType(
	value: unknown,
): value is ActionableEntityType {
	return (
		typeof value === "string" &&
		(ACTIONABLE_ENTITY_TYPES as readonly string[]).includes(value)
	);
}

export interface ActionableEntityDimensionProperties {
	priority_level?: PriorityLevel | null;
	status?: TaskStatusSlug | null;
	task_type?: TaskTypeSlug | null;
	recurrence_rule?: string | null;
	effort?: TaskEffortSlug | null;
	energy_mode?: TaskEnergyModeSlug | null;
	source?: TaskSourceSlug | null;
}

export interface ActionableEntityValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateActionableEntityProperties(
	properties: Record<string, unknown> | null | undefined,
): ActionableEntityValidationResult {
	if (!properties || typeof properties !== "object") {
		return { valid: true, errors: [] };
	}
	const errors: string[] = [];

	if (
		properties.priority_level !== undefined &&
		properties.priority_level !== null &&
		!isPriorityLevel(properties.priority_level)
	) {
		errors.push(
			`priority_level must be an integer between 1 and 7, received ${String(properties.priority_level)}`,
		);
	}
	if (
		properties.status !== undefined &&
		properties.status !== null &&
		!isTaskStatusSlug(properties.status)
	) {
		errors.push(
			`status must be one of (${TASK_STATUS_SLUGS.join(", ")}), received ${String(properties.status)}`,
		);
	}
	if (
		properties.task_type !== undefined &&
		properties.task_type !== null &&
		!isTaskTypeSlug(properties.task_type)
	) {
		errors.push(
			`task_type must be one of (${TASK_TYPE_SLUGS.join(", ")}), received ${String(properties.task_type)}`,
		);
	}
	if (
		properties.recurrence_rule !== undefined &&
		properties.recurrence_rule !== null &&
		typeof properties.recurrence_rule !== "string"
	) {
		errors.push(
			`recurrence_rule must be a string or null, received ${typeof properties.recurrence_rule}`,
		);
	}
	if (
		properties.effort !== undefined &&
		properties.effort !== null &&
		!isTaskEffortSlug(properties.effort)
	) {
		errors.push(
			`effort must be one of (${TASK_EFFORT_SLUGS.join(", ")}), received ${String(properties.effort)}`,
		);
	}
	if (
		properties.energy_mode !== undefined &&
		properties.energy_mode !== null &&
		!isTaskEnergyModeSlug(properties.energy_mode)
	) {
		errors.push(
			`energy_mode must be one of (${TASK_ENERGY_MODE_SLUGS.join(", ")}), received ${String(properties.energy_mode)}`,
		);
	}
	if (
		properties.source !== undefined &&
		properties.source !== null &&
		!isTaskSourceSlug(properties.source)
	) {
		errors.push(
			`source must be one of (${TASK_SOURCE_SLUGS.join(", ")}), received ${String(properties.source)}`,
		);
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

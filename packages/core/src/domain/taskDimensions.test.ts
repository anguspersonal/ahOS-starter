import { describe, expect, it, vi } from "vitest";
import { actionableEntityPropertiesSchema } from "../actions/domain/entities.js";
import { runTaskCrud, taskCrudSchema } from "../actions/tasks/taskCrudBody.js";
import type { TaskRepository, UserTaskRow } from "../ports/tasks.js";
import {
	ACTIONABLE_ENTITY_TYPES,
	DEFAULT_TASK_STATUS,
	DEFAULT_TASK_TYPE,
	getTaskEffortTerm,
	getTaskEnergyModeTerm,
	getTaskSourceTerm,
	getTaskStatusTerm,
	getTaskTypeTerm,
	isActionableEntityType,
	isTaskEffortSlug,
	isTaskEnergyModeSlug,
	isTaskSourceSlug,
	isTaskStatusSlug,
	isTaskTypeSlug,
	TASK_EFFORT_SLUGS,
	TASK_EFFORT_TERMS,
	TASK_ENERGY_MODE_SLUGS,
	TASK_ENERGY_MODE_TERMS,
	TASK_SOURCE_SLUGS,
	TASK_SOURCE_TERMS,
	TASK_STATUS_SLUGS,
	TASK_STATUS_TERMS,
	TASK_TYPE_SLUGS,
	TASK_TYPE_TERMS,
	validateActionableEntityProperties,
} from "./taskDimensions.js";

describe("taskDimensions (ADR-117, #2074)", () => {
	it("defines all 7 lifecycle status terms with { id, slug, display, meaning } and default todo", () => {
		expect(DEFAULT_TASK_STATUS).toBe("todo");
		expect(TASK_STATUS_SLUGS).toEqual([
			"proposed",
			"someday",
			"todo",
			"in_progress",
			"blocked",
			"done",
			"cancelled",
		]);
		expect(TASK_STATUS_TERMS).toHaveLength(7);
		expect(TASK_STATUS_TERMS.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(getTaskStatusTerm("proposed")).toEqual({
			id: 1,
			slug: "proposed",
			display: "Proposed",
			meaning:
				"Not confirmed it will or should be done yet; needs owner decision before promoting to To Do.",
		});
		expect(isTaskStatusSlug("someday")).toBe(true);
		expect(isTaskStatusSlug("blocked")).toBe(true);
		expect(isTaskStatusSlug("invalid")).toBe(false);
	});

	it("defines all 4 task_type terms with { id, slug, display, meaning } and default one_off", () => {
		expect(DEFAULT_TASK_TYPE).toBe("one_off");
		expect(TASK_TYPE_SLUGS).toEqual([
			"one_off",
			"recurring",
			"habit",
			"milestone",
		]);
		expect(TASK_TYPE_TERMS).toHaveLength(4);
		expect(TASK_TYPE_TERMS.map((t) => t.id)).toEqual([1, 2, 3, 4]);
		expect(getTaskTypeTerm("recurring").display).toBe("Recurring");
		expect(isTaskTypeSlug("habit")).toBe(true);
		expect(isTaskTypeSlug("unknown")).toBe(false);
	});

	it("defines all 4 effort terms, 4 energy_mode terms, and 5 source terms", () => {
		expect(TASK_EFFORT_SLUGS).toEqual(["quick", "small", "medium", "large"]);
		expect(TASK_EFFORT_TERMS.map((t) => t.id)).toEqual([1, 2, 3, 4]);
		expect(getTaskEffortTerm("quick").display).toBe("Quick (<15m)");
		expect(isTaskEffortSlug("quick")).toBe(true);
		expect(isTaskEffortSlug("huge")).toBe(false);

		expect(TASK_ENERGY_MODE_SLUGS).toEqual([
			"deep_work",
			"admin",
			"waiting_on",
			"quick_win",
		]);
		expect(TASK_ENERGY_MODE_TERMS.map((t) => t.id)).toEqual([1, 2, 3, 4]);
		expect(getTaskEnergyModeTerm("deep_work").display).toBe("Deep Work");
		expect(isTaskEnergyModeSlug("waiting_on")).toBe(true);
		expect(isTaskEnergyModeSlug("sleep")).toBe(false);

		expect(TASK_SOURCE_SLUGS).toEqual([
			"owner",
			"agent_proposed",
			"email_triage",
			"meeting_sweep",
			"ritual",
		]);
		expect(TASK_SOURCE_TERMS.map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
		expect(getTaskSourceTerm("agent_proposed").display).toBe("Agent Proposed");
		expect(isTaskSourceSlug("ritual")).toBe(true);
		expect(isTaskSourceSlug("random")).toBe(false);
	});

	it("identifies actionable entity types and validates actionable entity properties", () => {
		expect(ACTIONABLE_ENTITY_TYPES).toEqual([
			"project",
			"arrangement",
			"decision",
			"event",
		]);
		expect(isActionableEntityType("project")).toBe(true);
		expect(isActionableEntityType("arrangement")).toBe(true);
		expect(isActionableEntityType("people")).toBe(false);

		expect(
			validateActionableEntityProperties({
				priority_level: 5,
				status: "proposed",
				task_type: "recurring",
				recurrence_rule: "FREQ=WEEKLY;BYDAY=MO",
				effort: "small",
				energy_mode: "admin",
				source: "ritual",
			}),
		).toEqual({ valid: true, errors: [] });

		const invalid = validateActionableEntityProperties({
			priority_level: 9,
			status: "archived",
			task_type: "daily",
			recurrence_rule: 42,
			effort: "tiny",
			energy_mode: "focus",
			source: "slack",
		});
		expect(invalid.valid).toBe(false);
		expect(invalid.errors).toHaveLength(7);

		const parsedProps = actionableEntityPropertiesSchema.safeParse({
			priority_level: 6,
			status: "blocked",
			task_type: "milestone",
			effort: "medium",
			energy_mode: "deep_work",
			source: "owner",
			custom_key: "preserved",
		});
		expect(parsedProps.success).toBe(true);
	});

	it("wires orthogonal dimensions through taskCrudSchema and runTaskCrud create, query, and update", async () => {
		const fakeRow: UserTaskRow = {
			id: "00000000-0000-4000-8000-000000000001",
			title: "Review quarterly recurring arrangement",
			description: null,
			status: "proposed",
			priority: "high",
			priority_level: 5,
			task_type: "recurring",
			recurrence_rule: "FREQ=MONTHLY",
			effort: "quick",
			energy_mode: "admin",
			source: "agent_proposed",
			due_date: null,
			completed_at: null,
			assigned_to: null,
			created_by: null,
			created_via: "system",
			confidence_score: null,
			tags: null,
			notes: null,
			entity_id: null,
			source_artifact_id: null,
			due_time: null,
			duration_minutes: null,
			team_id: null,
			created_at: "2026-10-31T00:00:00.000Z",
			updated_at: "2026-10-31T00:00:00.000Z",
			user_id: "user-1",
		};

		const repo: TaskRepository = {
			query: vi.fn().mockResolvedValue([fakeRow]),
			get: vi.fn().mockResolvedValue(fakeRow),
			insert: vi.fn().mockResolvedValue(fakeRow),
			update: vi.fn().mockResolvedValue(fakeRow),
			deleteOne: vi.fn().mockResolvedValue([fakeRow.id]),
			deleteMany: vi.fn().mockResolvedValue([fakeRow.id]),
		};

		const createInput = taskCrudSchema.parse({
			operation: "create",
			title: "Review quarterly recurring arrangement",
			status: "proposed",
			priority_level: 5,
			task_type: "recurring",
			recurrence_rule: "FREQ=MONTHLY",
			effort: "quick",
			energy_mode: "admin",
			source: "agent_proposed",
		});
		await runTaskCrud(repo, createInput, { userId: "user-1" });
		expect(repo.insert).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "proposed",
				priority: "high",
				priority_level: 5,
				task_type: "recurring",
				recurrence_rule: "FREQ=MONTHLY",
				effort: "quick",
				energy_mode: "admin",
				source: "agent_proposed",
			}),
			"user-1",
		);

		const queryInput = taskCrudSchema.parse({
			operation: "query",
			status: "someday",
			task_type: "habit",
			effort: "small",
			energy_mode: "quick_win",
			source: "ritual",
		});
		await runTaskCrud(repo, queryInput, { userId: "user-1" });
		expect(repo.query).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "someday",
				task_type: "habit",
				effort: "small",
				energy_mode: "quick_win",
				source: "ritual",
			}),
			"user-1",
		);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry, AdapterUnavailableError } from "../buildRegistry.js";
import { executeAction } from "../adapters/direct.js";
import { actionResolver, executeApproved } from "../approvals.js";
import {
	ApprovalDeniedError,
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "../gate.js";
import type { TasksPort } from "../../ports/tasks.js";
import { createTaskInput, taskCrudSchema } from "../domain/tasks.js";
import { formatCreateTaskMcp } from "./createTask.js";
import { formatTaskCrudMcp } from "./taskCrud.js";

describe("Tasks Actions in @ahkms/core (Issue #1519, ADR-101, ADR-105)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
	});
	it("1. buildRegistry({ tasks: fakePort }) holds task_crud and task_create; each runs its port method once with the parsed input and context user id", async () => {
		const fakeCreateResult = {
			status: "created" as const,
			title: "Call Dentist",
			deduplicated: false,
			message: "Created Notion task: Call Dentist",
		};
		const fakeCrudResult = {
			operation: "get",
			task: {
				id: "11111111-1111-4111-a111-111111111111",
				title: "Call Dentist",
				description: null,
				status: "todo",
				priority: "medium",
				due_date: null,
				completed_at: null,
				assigned_to: null,
				created_by: null,
				created_via: null,
				confidence_score: null,
				tags: null,
				notes: null,
				entity_id: null,
				source_artifact_id: null,
				due_time: null,
				duration_minutes: null,
				team_id: null,
				created_at: "2026-10-12T10:00:00Z",
				updated_at: "2026-10-12T10:00:00Z",
				user_id: "u1",
			},
		};

		const fakePort: TasksPort = {
			createTask: vi.fn().mockResolvedValue(fakeCreateResult),
			taskCrud: vi.fn().mockResolvedValue(fakeCrudResult),
		};

		const registry = buildRegistry({ tasks: fakePort });
		expect(registry.has("task_create")).toBe(true);
		expect(registry.has("task_crud")).toBe(true);

		// Test task_create execution
		const taskCreate = registry.get("task_create")!;
		const createResult = await executeAction(
			taskCreate,
			{ title: "Call Dentist", domain: "work" },
			{ context: { userId: "u1" } },
		);
		expect(fakePort.createTask).toHaveBeenCalledTimes(1);
		expect(fakePort.createTask).toHaveBeenCalledWith(
			{ title: "Call Dentist", domain: "work" },
			"u1",
		);
		expect(createResult).toEqual(fakeCreateResult);

		// Test task_crud execution
		const taskCrud = registry.get("task_crud")!;
		const crudResult = await executeAction(
			taskCrud,
			{ operation: "get", id: "11111111-1111-4111-a111-111111111111" },
			{ context: { userId: "u1" } },
		);
		expect(fakePort.taskCrud).toHaveBeenCalledTimes(1);
		expect(fakePort.taskCrud).toHaveBeenCalledWith(
			{ operation: "get", id: "11111111-1111-4111-a111-111111111111" },
			expect.objectContaining({ userId: "u1" }),
		);
		expect(crudResult).toEqual(fakeCrudResult);
	});

	it("2. task_create keeps openWorldHint: true, its description and every key of createTaskInput; task_crud keeps its dev description and schema", () => {
		const fakePort: TasksPort = {
			createTask: vi.fn(),
			taskCrud: vi.fn(),
		};
		const registry = buildRegistry({ tasks: fakePort });

		const taskCreate = registry.get("task_create")!;
		expect(taskCreate.annotations.openWorldHint).toBe(true);
		expect(taskCreate.description).toBe(
			"Create a task in Notion. `domain` ('work' or 'angus') is required. " +
				"Ask before adding (ADR-038). Pass `for_person_id` for commitments to people. " +
				"Guarded against matching open Tasks-DB tasks. WARNING: `single_task` on an atom " +
				"holding several tasks silently skips after the first. Full notes: docs/guides/tools/task_create.md",
		);
		const schemaKeys = Object.keys((taskCreate.schema as any).shape);
		const inputKeys = Object.keys(createTaskInput);
		for (const key of inputKeys) {
			expect(schemaKeys).toContain(key);
		}

		const taskCrud = registry.get("task_crud")!;
		expect(taskCrud.description).toBe(
			"Create, query, get, update, complete, delete, or bulk-delete actionable user tasks in ahOS.",
		);
		expect(taskCrud.domain).toBe("para");
		expect(taskCrud.schema).toBe(taskCrudSchema);
	});

	it("3. formatMcp on fixture results matches the dev formatter output", () => {
		// formatCreateTaskMcp
		expect(
			formatCreateTaskMcp({
				status: "created",
				title: "Call Dentist",
				deduplicated: false,
				message: "Created Notion task: Call Dentist\nPage: https://notion.so/p1",
			}),
		).toBe("Created Notion task: Call Dentist\nPage: https://notion.so/p1");

		// formatTaskCrudMcp
		expect(formatTaskCrudMcp({ operation: "query", count: 0, tasks: [] })).toBe(
			"No tasks found matching criteria.",
		);
		expect(
			formatTaskCrudMcp({
				operation: "query",
				count: 1,
				tasks: [
					{
						id: "t1",
						title: "Tax Return",
						status: "todo",
						priority: "urgent",
						due_date: "2026-10-15T00:00:00Z",
					} as any,
				],
			}),
		).toBe("Found 1 task(s):\n- [t1] Tax Return: status=todo, priority=urgent (due: 2026-10-15)");

		expect(formatTaskCrudMcp({ operation: "delete", deleted_count: 1 })).toBe(
			"Deleted 1 task(s).",
		);
		expect(formatTaskCrudMcp({ operation: "bulk_delete", deleted_count: 4 })).toBe(
			"Deleted 4 task(s).",
		);
		expect(
			formatTaskCrudMcp({
				operation: "create",
				task: {
					id: "t1",
					title: "Tax Return",
					status: "todo",
					priority: "high",
				} as any,
			}),
		).toBe('Task [t1] created: "Tax Return" (status=todo, priority=high).');
	});

	it("4. With {}, task_create rejects with AdapterUnavailableError naming tasks", async () => {
		const registry = buildRegistry({});
		const action = registry.get("task_create")!;
		expect(action).toBeDefined();

		await expect(
			executeAction(
				action,
				{ title: "Test Task", domain: "work" },
				{ context: { userId: "u1" } },
			),
		).rejects.toThrowError(AdapterUnavailableError);

		await expect(
			executeAction(
				action,
				{ title: "Test Task", domain: "work" },
				{ context: { userId: "u1" } },
			),
		).rejects.toThrowError(/tasks adapter is not wired/i);
	});

	it("5. task_create review-band confidence gating (#1976): >= 0.85 executes, [0.30, 0.85) parks and replays via executeApproved, < 0.30 denies", async () => {
		const parked: ApprovalRequest[] = [];
		const lifecycleStore: ActionApprovalLifecycleStore = {
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: "dec-task-1" };
			}),
			claim: vi.fn(async (decisionId: string) => {
				if (decisionId !== "dec-task-1" || parked.length === 0) return null;
				const req = parked[0];
				return {
					decisionId,
					actionId: req.actionId,
					input: req.input,
					inputSha256: req.inputSha256,
					caller: req.caller,
					userId: req.userId ?? "u1",
				};
			}),
			finish: vi.fn(async () => {}),
			reject: vi.fn(async () => true),
		};
		setActionApprovalStore(lifecycleStore);

		const fakeCreateResult = {
			status: "created" as const,
			title: "Review Band Task",
			deduplicated: false,
			message: "Created Notion task: Review Band Task",
		};
		const fakePort: TasksPort = {
			createTask: vi.fn().mockResolvedValue(fakeCreateResult),
			taskCrud: vi.fn(),
		};
		const registry = buildRegistry({ tasks: fakePort });
		const taskCreate = registry.get("task_create")!;

		// 1) >= 0.85 executes immediately
		const highRes = await executeAction(
			taskCreate,
			{ title: "High Conf Task", domain: "work", confidence: { epistemic: 0.9 } },
			{ context: { caller: "mcp", userId: "u1" } },
		);
		expect(highRes).toEqual(fakeCreateResult);
		expect(fakePort.createTask).toHaveBeenCalledTimes(1);
		expect(parked).toHaveLength(0);

		// 2) [0.30, 0.85) parks as PendingApprovalError without calling port
		await expect(
			executeAction(
				taskCreate,
				{ title: "Review Band Task", domain: "work", confidence: { epistemic: 0.65 } },
				{ context: { caller: "mcp", userId: "u1" } },
			),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(fakePort.createTask).toHaveBeenCalledTimes(1);
		expect(parked).toHaveLength(1);
		expect(parked[0].actionId).toBe("task_create");

		// Replay parked decision via executeApproved
		const replayResult = await executeApproved("dec-task-1", {
			store: lifecycleStore,
			resolve: actionResolver(registry),
			approvedBy: { userId: "u1", via: "web_inbox" },
		});
		expect(replayResult).toEqual({ status: "executed", result: fakeCreateResult });
		expect(fakePort.createTask).toHaveBeenCalledTimes(2);
		expect(lifecycleStore.finish).toHaveBeenCalledWith("dec-task-1", { outcome: "executed" });

		// 3) < 0.30 throws ApprovalDeniedError without parking or calling port
		await expect(
			executeAction(
				taskCreate,
				{ title: "Low Conf Task", domain: "work", confidence: { epistemic: 0.2 } },
				{ context: { caller: "mcp", userId: "u1" } },
			),
		).rejects.toBeInstanceOf(ApprovalDeniedError);
		expect(fakePort.createTask).toHaveBeenCalledTimes(2);
		expect(parked).toHaveLength(1);
	});
});

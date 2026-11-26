import { describe, expect, it, vi, beforeEach } from "vitest";
import { taskCrudAction, taskCrudCore } from "./tasks.js";

const mockTasks = [
	{
		id: "aaaaaaa1-1111-1111-1111-111111111111",
		title: "Review Q3 OKRs",
		description: "Check milestones and key results",
		status: "todo",
		priority: "high",
		due_date: "2026-10-15T18:00:00.000Z",
		completed_at: null,
		assigned_to: null,
		created_by: "test-user-id",
		created_via: "system",
		confidence_score: null,
		tags: ["okrs", "planning"],
		notes: null,
		entity_id: null,
		source_artifact_id: null,
		due_time: null,
		duration_minutes: 60,
		team_id: null,
		created_at: "2026-10-01T10:00:00.000Z",
		updated_at: "2026-10-01T10:00:00.000Z",
		user_id: "test-user-id",
	},
];

let mockQueryData: any = mockTasks;
let mockSingleData: any = mockTasks[0];

vi.mock("../supabase.js", () => {
	const chain: any = {
		select: vi.fn(() => chain),
		order: vi.fn(() => chain),
		limit: vi.fn(() => chain),
		eq: vi.fn(() => chain),
		lte: vi.fn(() => chain),
		gte: vi.fn(() => chain),
		ilike: vi.fn(() => chain),
		in: vi.fn(() => chain),
		single: vi.fn(async () => ({ data: mockSingleData, error: null })),
		insert: vi.fn(() => chain),
		update: vi.fn(() => chain),
		delete: vi.fn(() => chain),
		then: (resolve: any) => resolve({ data: mockQueryData, error: null }),
	};

	return {
		supabase: {
			from: vi.fn(() => chain),
		},
	};
});

vi.mock("../identity.js", () => ({
	getCurrentUserId: () => "test-user-id",
}));

describe("taskCrudAction", () => {
	beforeEach(() => {
		mockQueryData = mockTasks;
		mockSingleData = mockTasks[0];
	});

	it("has correct domain and annotations", () => {
		expect(taskCrudAction.id).toBe("task_crud");
		expect(taskCrudAction.domain).toBe("para");
	});

	it("queries tasks with filters", async () => {
		const result = await taskCrudCore({
			operation: "query",
			status: "todo",
			priority: "high",
		});

		expect(result.operation).toBe("query");
		expect(result.count).toBe(1);
		expect(result.tasks![0].title).toBe("Review Q3 OKRs");
	});

	it("gets a single task by ID", async () => {
		const result = await taskCrudCore({
			operation: "get",
			id: "aaaaaaa1-1111-1111-1111-111111111111",
		});

		expect(result.operation).toBe("get");
		expect(result.task?.id).toBe("aaaaaaa1-1111-1111-1111-111111111111");
	});

	it("creates a new task", async () => {
		mockSingleData = {
			...mockTasks[0],
			id: "bbbbbbb2-2222-2222-2222-222222222222",
			title: "Draft weekly update",
			status: "todo",
		};

		const result = await taskCrudCore({
			operation: "create",
			title: "Draft weekly update",
			priority: "medium",
		});

		expect(result.operation).toBe("create");
		expect(result.task?.title).toBe("Draft weekly update");
	});

	it("updates a task", async () => {
		mockSingleData = {
			...mockTasks[0],
			priority: "urgent",
		};

		const result = await taskCrudCore({
			operation: "update",
			id: "aaaaaaa1-1111-1111-1111-111111111111",
			priority: "urgent",
		});

		expect(result.operation).toBe("update");
		expect(result.task?.priority).toBe("urgent");
	});

	it("completes a task", async () => {
		mockSingleData = {
			...mockTasks[0],
			status: "done",
			completed_at: "2026-10-03T12:00:00.000Z",
		};

		const result = await taskCrudCore({
			operation: "complete",
			id: "aaaaaaa1-1111-1111-1111-111111111111",
		});

		expect(result.operation).toBe("complete");
		expect(result.task?.status).toBe("done");
		expect(result.task?.completed_at).toBeTruthy();
	});

	it("deletes a task", async () => {
		const result = await taskCrudCore({
			operation: "delete",
			id: "aaaaaaa1-1111-1111-1111-111111111111",
		});

		expect(result.operation).toBe("delete");
		expect(result.deleted_count).toBe(1);
	});

	it("bulk deletes tasks", async () => {
		mockQueryData = [
			{ id: "aaaaaaa1-1111-1111-1111-111111111111" },
			{ id: "bbbbbbb2-2222-2222-2222-222222222222" },
		];

		const result = await taskCrudCore({
			operation: "bulk_delete",
			ids: [
				"aaaaaaa1-1111-1111-1111-111111111111",
				"bbbbbbb2-2222-2222-2222-222222222222",
			],
		});

		expect(result.operation).toBe("bulk_delete");
		expect(result.deleted_count).toBe(2);
	});

	it("reports accurate delete count on bulk_delete with no matching rows", async () => {
		mockQueryData = [];
		const result = await taskCrudCore({
			operation: "bulk_delete",
			ids: [
				"11111111-1111-1111-1111-111111111111",
				"22222222-2222-2222-2222-222222222222",
			],
		});

		expect(result.operation).toBe("bulk_delete");
		expect(result.deleted_count).toBe(0);
		expect(result.ids).toEqual([]);
	});

	it("throws when delete count is zero because task is not found", async () => {
		mockQueryData = [];
		const missingId = "33333333-3333-3333-3333-333333333333";
		await expect(
			taskCrudCore({
				operation: "delete",
				id: missingId,
			}),
		).rejects.toThrow(new RegExp(`${missingId}.*not found`));
	});

	it("formats mcp output correctly", () => {
		const format = taskCrudAction.formatMcp!;
		const text = format({
			operation: "query",
			count: 1,
			tasks: mockTasks as any,
		});

		expect(text).toContain("Found 1 task(s):");
		expect(text).toContain("Review Q3 OKRs");
	});
});

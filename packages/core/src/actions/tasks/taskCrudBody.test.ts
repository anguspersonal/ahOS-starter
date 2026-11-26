import { describe, expect, it, vi } from "vitest";
import type { TaskRepository, UserTaskRow } from "../../ports/tasks.js";
import { runTaskCrud } from "./taskCrudBody.js";

const sampleRow: UserTaskRow = {
	id: "11111111-1111-1111-1111-111111111111",
	title: "Sample Task",
	description: null,
	status: "todo",
	priority: "medium",
	priority_level: 4,
	due_date: null,
	completed_at: null,
	assigned_to: null,
	created_by: "user-1",
	created_via: "system",
	confidence_score: null,
	tags: null,
	notes: null,
	entity_id: null,
	source_artifact_id: null,
	due_time: null,
	duration_minutes: null,
	team_id: null,
	created_at: "2026-10-16T00:00:00.000Z",
	updated_at: "2026-10-16T00:00:00.000Z",
	user_id: "user-1",
};

function createFakeRepo(overrides: Partial<TaskRepository> = {}): TaskRepository {
	return {
		query: vi.fn(async () => [sampleRow]),
		get: vi.fn(async () => sampleRow),
		insert: vi.fn(async (row) => ({ ...sampleRow, ...row }) as UserTaskRow),
		update: vi.fn(async (_id, payload) => ({ ...sampleRow, ...payload }) as UserTaskRow),
		deleteOne: vi.fn(async (id) => [id]),
		deleteMany: vi.fn(async (ids) => ids),
		...overrides,
	};
}

describe("runTaskCrud", () => {
	it("2. create without a title rejects before any repository call; with caller 'ui' sets created_via: 'manual' and 'system' otherwise", async () => {
		const insertSpy = vi.fn(async (row: Record<string, unknown>) => ({ ...sampleRow, ...row }) as UserTaskRow);
		const repo = createFakeRepo({ insert: insertSpy });

		await expect(
			runTaskCrud(repo, { operation: "create", title: "   " }, { caller: "ui", userId: "user-1" }),
		).rejects.toThrow("title is required for create operation");
		expect(insertSpy).not.toHaveBeenCalled();

		const uiRes = await runTaskCrud(
			repo,
			{ operation: "create", title: "From UI" },
			{ caller: "ui", userId: "user-1" },
		);
		expect(uiRes.task?.created_via).toBe("manual");
		expect(insertSpy.mock.calls[0]?.[0]?.created_via).toBe("manual");

		const mcpRes = await runTaskCrud(
			repo,
			{ operation: "create", title: "From MCP" },
			{ caller: "mcp", userId: "user-1" },
		);
		expect(mcpRes.task?.created_via).toBe("system");
		expect(insertSpy.mock.calls[1]?.[0]?.created_via).toBe("system");
	});

	it("3. with no user id, no method receives one and the inserted row has no user_id or created_by", async () => {
		const querySpy = vi.fn(async () => [sampleRow]);
		const getSpy = vi.fn(async () => sampleRow);
		const insertSpy = vi.fn(async (row: Record<string, unknown>) => ({ ...sampleRow, ...row }) as UserTaskRow);
		const updateSpy = vi.fn(async (_id: string, payload: Record<string, unknown>) => ({ ...sampleRow, ...payload }) as UserTaskRow);
		const deleteOneSpy = vi.fn(async (id: string) => [id]);
		const deleteManySpy = vi.fn(async (ids: string[]) => ids);
		const repo = createFakeRepo({
			query: querySpy,
			get: getSpy,
			insert: insertSpy,
			update: updateSpy,
			deleteOne: deleteOneSpy,
			deleteMany: deleteManySpy,
		});

		await runTaskCrud(repo, { operation: "query" });
		expect(querySpy).toHaveBeenCalledWith(expect.any(Object), undefined);

		await runTaskCrud(repo, { operation: "get", id: sampleRow.id });
		expect(getSpy).toHaveBeenCalledWith(sampleRow.id, undefined);

		await runTaskCrud(repo, { operation: "create", title: "Anonymous Task" });
		expect(insertSpy).toHaveBeenCalledWith(expect.any(Object), undefined);
		const insertedRow = insertSpy.mock.calls[0]?.[0] ?? {};
		expect(insertedRow).not.toHaveProperty("user_id");
		expect(insertedRow).not.toHaveProperty("created_by");

		await runTaskCrud(repo, { operation: "update", id: sampleRow.id, title: "Updated" });
		expect(updateSpy).toHaveBeenCalledWith(sampleRow.id, expect.any(Object), undefined);

		await runTaskCrud(repo, { operation: "delete", id: sampleRow.id });
		expect(deleteOneSpy).toHaveBeenCalledWith(sampleRow.id, undefined);

		await runTaskCrud(repo, { operation: "bulk_delete", ids: [sampleRow.id] });
		expect(deleteManySpy).toHaveBeenCalledWith([sampleRow.id], undefined);
	});

	it("update merges patch over the top-level fields", async () => {
		const updateSpy = vi.fn(async (_id: string, payload: Record<string, unknown>) => ({
			...sampleRow,
			...payload,
		}) as UserTaskRow);
		const repo = createFakeRepo({ update: updateSpy });

		await runTaskCrud(
			repo,
			{
				operation: "update",
				id: sampleRow.id,
				title: "Top-level title",
				priority: "low",
				patch: {
					priority: "urgent",
					notes: "Patched notes",
				},
			},
			{ caller: "mcp", userId: "user-1" },
		);

		const passedPayload = updateSpy.mock.calls[0]?.[1];
		expect(passedPayload?.title).toBe("Top-level title");
		expect(passedPayload?.priority).toBe("urgent");
		expect(passedPayload?.notes).toBe("Patched notes");
	});

	it("4. bulk_delete reports deleted_count and ids from repo.deleteMany", async () => {
		const requestedIds = [
			"11111111-1111-1111-1111-111111111111",
			"22222222-2222-2222-2222-222222222222",
		];
		const repo = createFakeRepo({
			deleteMany: vi.fn(async () => []),
		});

		const result = await runTaskCrud(repo, {
			operation: "bulk_delete",
			ids: requestedIds,
		});

		expect(result.operation).toBe("bulk_delete");
		expect(result.deleted_count).toBe(0);
		expect(result.ids).toEqual([]);
	});

	it("5. synchronizes canonical priority_level (1..7) and coarse priority on create, update, and query (#1986)", async () => {
		const querySpy = vi.fn(async () => [sampleRow]);
		const insertSpy = vi.fn(
			async (row: Record<string, unknown>) => ({ ...sampleRow, ...row }) as UserTaskRow,
		);
		const updateSpy = vi.fn(
			async (_id: string, payload: Record<string, unknown>) =>
				({ ...sampleRow, ...payload }) as UserTaskRow,
		);
		const repo = createFakeRepo({
			query: querySpy,
			insert: insertSpy,
			update: updateSpy,
		});

		await runTaskCrud(repo, { operation: "query", priority_level: 5 });
		expect(querySpy).toHaveBeenCalledWith(
			expect.objectContaining({ priority_level: 5 }),
			undefined,
		);

		const createdFromLevel = await runTaskCrud(repo, {
			operation: "create",
			title: "Critical task",
			priority_level: 7,
		});
		expect(createdFromLevel.task?.priority_level).toBe(7);
		expect(createdFromLevel.task?.priority).toBe("urgent");

		const createdFromCoarse = await runTaskCrud(repo, {
			operation: "create",
			title: "High task",
			priority: "high",
		});
		expect(createdFromCoarse.task?.priority).toBe("high");
		expect(createdFromCoarse.task?.priority_level).toBe(5);

		const updatedFromLevel = await runTaskCrud(repo, {
			operation: "update",
			id: sampleRow.id,
			patch: { priority_level: 1 },
		});
		expect(updatedFromLevel.task?.priority_level).toBe(1);
		expect(updatedFromLevel.task?.priority).toBe("low");

		const updatedTopLevelFromLevel = await runTaskCrud(repo, {
			operation: "update",
			id: sampleRow.id,
			priority_level: 7,
		});
		expect(updatedTopLevelFromLevel.task?.priority_level).toBe(7);
		expect(updatedTopLevelFromLevel.task?.priority).toBe("urgent");

		const updatedTopLevelFromCoarse = await runTaskCrud(repo, {
			operation: "update",
			id: sampleRow.id,
			priority: "high",
		});
		expect(updatedTopLevelFromCoarse.task?.priority).toBe("high");
		expect(updatedTopLevelFromCoarse.task?.priority_level).toBe(5);

		const updatedPatchOverridesTopLevelPriority = await runTaskCrud(repo, {
			operation: "update",
			id: sampleRow.id,
			priority: "low",
			patch: { priority_level: 7 },
		});
		expect(updatedPatchOverridesTopLevelPriority.task?.priority_level).toBe(7);
		expect(updatedPatchOverridesTopLevelPriority.task?.priority).toBe("urgent");

		const updatedPatchOverridesTopLevelLevel = await runTaskCrud(repo, {
			operation: "update",
			id: sampleRow.id,
			priority_level: 2,
			patch: { priority: "urgent" },
		});
		expect(updatedPatchOverridesTopLevelLevel.task?.priority).toBe("urgent");
		expect(updatedPatchOverridesTopLevelLevel.task?.priority_level).toBe(6);
	});
});

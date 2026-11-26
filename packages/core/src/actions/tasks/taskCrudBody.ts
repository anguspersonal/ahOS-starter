import {
	isPriorityLevel,
	priorityLevelToTaskPriority,
	taskPriorityToLevel,
	type CoarseTaskPriority,
	type PriorityLevel,
} from "../../domain/priorityScale.js";
import type { TaskRepository } from "../../ports/tasks.js";
import {
	type TaskCrudInput,
	type TaskCrudResult,
	taskCrudSchema,
	taskFields,
	type UserTaskRow,
} from "../domain/tasks.js";
import type { ActionContext } from "../types.js";

export {
	taskFields,
	taskCrudSchema,
	type TaskCrudInput,
	type UserTaskRow,
	type TaskCrudResult,
};

/** Executes the seven-operation task_crud workflow against a TaskRepository port. */
export async function runTaskCrud(
	repo: TaskRepository,
	input: TaskCrudInput,
	ctx?: Partial<ActionContext>,
): Promise<TaskCrudResult> {
	const userId: string | undefined = ctx?.userId || undefined;
	const nowIso = new Date().toISOString();

	switch (input.operation) {
		case "query": {
			const data = await repo.query(
				{
					limit: input.limit,
					status: input.status,
					priority: input.priority,
					priority_level: input.priority_level,
					task_type: input.task_type,
					effort: input.effort,
					energy_mode: input.energy_mode,
					source: input.source,
					entity_id: input.entity_id,
					due_before: input.due_before,
					due_after: input.due_after,
					query: input.query,
				},
				userId,
			);

			return {
				operation: "query",
				count: data.length,
				tasks: data,
			};
		}

		case "get": {
			if (!input.id) {
				throw new Error("id is required for get operation");
			}

			const data = await repo.get(input.id, userId);

			return {
				operation: "get",
				task: data,
			};
		}

		case "create": {
			if (!input.title || input.title.trim().length === 0) {
				throw new Error("title is required for create operation");
			}

			const taskId = input.id ?? globalThis.crypto.randomUUID();
			const effectiveLevel: PriorityLevel =
				input.priority_level !== undefined && isPriorityLevel(input.priority_level)
					? input.priority_level
					: taskPriorityToLevel(input.priority ?? "medium");
			const effectivePriority =
				input.priority ?? priorityLevelToTaskPriority(effectiveLevel);
			const insertRow: Record<string, unknown> = {
				id: taskId,
				title: input.title.trim(),
				description: input.description ?? null,
				status: input.status ?? "todo",
				priority: effectivePriority,
				priority_level: effectiveLevel,
				task_type: input.task_type ?? "one_off",
				recurrence_rule: input.recurrence_rule ?? null,
				effort: input.effort ?? null,
				energy_mode: input.energy_mode ?? null,
				source: input.source ?? null,
				due_date: input.due_date ?? null,
				tags: input.tags ?? null,
				entity_id: input.entity_id ?? null,
				created_via: ctx?.caller === "ui" ? "manual" : "system",
				created_at: nowIso,
				updated_at: nowIso,
			};
			if (userId) {
				insertRow.user_id = userId;
				insertRow.created_by = userId;
			}

			const data = await repo.insert(insertRow, userId);

			return {
				operation: "create",
				task: data,
			};
		}

		case "update": {
			if (!input.id) {
				throw new Error("id is required for update operation");
			}

			const patch = input.patch ?? {};
			const updatePayload: Record<string, unknown> = {
				updated_at: nowIso,
			};

			if (input.title !== undefined) updatePayload.title = input.title;
			if (input.description !== undefined) updatePayload.description = input.description;
			if (input.status !== undefined) updatePayload.status = input.status;
			if (input.priority !== undefined) updatePayload.priority = input.priority;
			if (input.priority_level !== undefined) updatePayload.priority_level = input.priority_level;
			if (input.task_type !== undefined) updatePayload.task_type = input.task_type;
			if (input.recurrence_rule !== undefined) updatePayload.recurrence_rule = input.recurrence_rule;
			if (input.effort !== undefined) updatePayload.effort = input.effort;
			if (input.energy_mode !== undefined) updatePayload.energy_mode = input.energy_mode;
			if (input.source !== undefined) updatePayload.source = input.source;
			if (input.due_date !== undefined) updatePayload.due_date = input.due_date;
			if (input.tags !== undefined) updatePayload.tags = input.tags;
			if (input.entity_id !== undefined) updatePayload.entity_id = input.entity_id;

			Object.assign(updatePayload, patch);

			const patchSetPriorityFields =
				patch.priority_level !== undefined || patch.priority !== undefined;
			if (patchSetPriorityFields) {
				if (
					typeof patch.priority_level === "number" &&
					isPriorityLevel(patch.priority_level) &&
					patch.priority === undefined
				) {
					updatePayload.priority = priorityLevelToTaskPriority(
						patch.priority_level,
					);
				} else if (
					typeof patch.priority === "string" &&
					patch.priority_level === undefined
				) {
					updatePayload.priority_level = taskPriorityToLevel(
						patch.priority as CoarseTaskPriority,
					);
				}
			} else if (
				typeof input.priority_level === "number" &&
				isPriorityLevel(input.priority_level) &&
				input.priority === undefined
			) {
				updatePayload.priority = priorityLevelToTaskPriority(
					input.priority_level,
				);
			} else if (
				typeof input.priority === "string" &&
				input.priority_level === undefined
			) {
				updatePayload.priority_level = taskPriorityToLevel(
					input.priority as CoarseTaskPriority,
				);
			}

			let data: UserTaskRow;
			try {
				data = await repo.update(input.id, updatePayload, userId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to update task ${input.id}: ${msg}`);
			}

			return {
				operation: "update",
				task: data,
			};
		}

		case "complete": {
			if (!input.id) {
				throw new Error("id is required for complete operation");
			}

			const updatePayload: Record<string, unknown> = {
				status: "done",
				completed_at: nowIso,
				updated_at: nowIso,
			};

			let data: UserTaskRow;
			try {
				data = await repo.update(input.id, updatePayload, userId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to complete task ${input.id}: ${msg}`);
			}

			return {
				operation: "complete",
				task: data,
			};
		}

		case "delete": {
			if (!input.id) {
				throw new Error("id is required for delete operation");
			}

			const deletedIds = await repo.deleteOne(input.id, userId);
			if (deletedIds.length === 0) {
				throw new Error(`Task ${input.id} not found`);
			}

			return {
				operation: "delete",
				deleted_count: 1,
				ids: deletedIds,
			};
		}

		case "bulk_delete": {
			if (!input.ids || input.ids.length === 0) {
				throw new Error("ids array is required for bulk_delete operation");
			}

			const deletedIds = await repo.deleteMany(input.ids, userId);
			return {
				operation: "bulk_delete",
				deleted_count: deletedIds.length,
				ids: deletedIds,
			};
		}

		default:
			throw new Error(`Unsupported operation: ${(input as { operation: string }).operation}`);
	}
}

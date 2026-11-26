import { defineAction } from "../defineAction.js";
import {
	taskCrudSchema,
	type TaskCrudInput,
	type TaskCrudResult,
} from "../domain/tasks.js";
import type { TasksPort } from "../../ports/tasks.js";

export function formatTaskCrudMcp(result: TaskCrudResult): string {
	if (result.operation === "query") {
		if (!result.tasks || result.tasks.length === 0) {
			return "No tasks found matching criteria.";
		}
		const lines = [
			`Found ${result.count} task(s):`,
			...result.tasks.map(
				(t) =>
					`- [${t.id}] ${t.title}: status=${t.status}, priority=${t.priority ?? "none"}${t.due_date ? ` (due: ${t.due_date.slice(0, 10)})` : ""}`,
			),
		];
		return lines.join("\n");
	}
	if (result.operation === "delete" || result.operation === "bulk_delete") {
		return `Deleted ${result.deleted_count} task(s).`;
	}
	if (result.task) {
		const t = result.task;
		return `Task [${t.id}] ${result.operation}d: "${t.title}" (status=${t.status}, priority=${t.priority ?? "none"}).`;
	}
	return JSON.stringify(result, null, 2);
}

export function createTaskCrudAction(port: TasksPort | Pick<TasksPort, "taskCrud">) {
	return defineAction({
		id: "task_crud",
		name: "Task CRUD",
		description:
			"Create, query, get, update, complete, delete, or bulk-delete actionable user tasks in ahOS.",
		domain: "para",
		schema: taskCrudSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (input: TaskCrudInput, ctx) => port.taskCrud(input, ctx),
		formatMcp: formatTaskCrudMcp,
	});
}

import { defineAction } from "../defineAction.js";
import { needsReviewBandApproval } from "../gate.js";
import {
	createTaskSchema,
	type CreateTaskInput,
	type CreateTaskResult,
} from "../domain/tasks.js";
import type { TasksPort } from "../../ports/tasks.js";

export function formatCreateTaskMcp(result: CreateTaskResult): string {
	return result.message;
}

export function createCreateTaskAction(port: TasksPort | Pick<TasksPort, "createTask">) {
	return defineAction({
		id: "task_create",
		description:
			"Create a task in Notion. `domain` ('work' or 'angus') is required. " +
			"Ask before adding (ADR-038). Pass `for_person_id` for commitments to people. " +
			"Guarded against matching open Tasks-DB tasks. WARNING: `single_task` on an atom " +
			"holding several tasks silently skips after the first. Full notes: docs/guides/tools/task_create.md",
		schema: createTaskSchema,
		needsApproval: needsReviewBandApproval,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		run: async (args: CreateTaskInput, ctx) => {
			return await port.createTask(args, ctx.userId);
		},
		formatMcp: formatCreateTaskMcp,
	});
}

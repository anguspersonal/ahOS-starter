import {
	taskFields,
	taskCrudSchema,
	type TaskCrudInput,
	type UserTaskRow,
	type TaskCrudResult,
	createTaskCrudAction,
	runTaskCrud,
} from "@ahkms/core";
import { createSupabaseTaskRepository, type TasksSupabaseClient } from "@ahkms/core/adapters";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import type { ActionContext } from "./types.js";

export {
	taskFields,
	taskCrudSchema,
	type TaskCrudInput,
	type UserTaskRow,
	type TaskCrudResult,
	runTaskCrud,
};

export const taskRepository = createSupabaseTaskRepository(supabase as unknown as TasksSupabaseClient);

export async function taskCrudCore(
	input: TaskCrudInput,
	ctx?: ActionContext,
): Promise<TaskCrudResult> {
	let userId: string | undefined = ctx?.userId;
	if (!userId) {
		try {
			userId = getCurrentUserId();
		} catch {
			// Environment without user ID in mock tests
		}
	}
	return runTaskCrud(taskRepository, input, {
		...ctx,
		userId,
	});
}

export const taskCrudAction = createTaskCrudAction({
	taskCrud: taskCrudCore,
});

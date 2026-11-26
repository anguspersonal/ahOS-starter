import type { TaskRepository, TasksPort } from "../../ports/tasks.js";
import { runCreateTask, type CreateTaskPorts } from "./createTaskBody.js";
import { runTaskCrud } from "./taskCrudBody.js";

export interface CoreTasksDeps extends CreateTaskPorts {
	tasks: TaskRepository;
	/** The owner when a caller passes no user id, as the server's port resolved it before #1662. */
	ownerId?: () => string | undefined;
}

/** Binds all of `TasksPort` to the core bodies over core ports (ADR-101 §1, #1662). */
export function createCoreTasksPort(deps: CoreTasksDeps): TasksPort {
	return {
		taskCrud: (input, ctx) =>
			runTaskCrud(deps.tasks, input, { ...ctx, userId: ctx?.userId || deps.ownerId?.() }),
		createTask: async (input, userId) => {
			const ownerId = userId ?? deps.ownerId?.();
			if (!ownerId) throw new Error("task_create needs the owner's user id, and none was given.");
			return runCreateTask(deps, input, ownerId);
		},
	};
}

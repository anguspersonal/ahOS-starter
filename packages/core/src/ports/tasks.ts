/**
 * Ports for task management interactions (ADR-101 §1, §4, ADR-105 R1, R7).
 * Pure types only. No external SDKs, database, or environment dependencies.
 */

import type { ActionContext } from "../actions/types.js";
import type {
	TaskCrudInput,
	TaskCrudResult,
	CreateTaskInput,
	CreateTaskResult,
	UserTaskRow,
} from "../actions/domain/tasks.js";

export type {
	TaskCrudResult,
	CreateTaskResult,
	UserTaskRow,
};

/** Filter options accepted by TaskRepository.query over user_tasks. */
export interface TaskQueryFilters {
	limit?: number;
	status?: string;
	priority?: string;
	priority_level?: number;
	task_type?: string;
	effort?: string | null;
	energy_mode?: string | null;
	source?: string | null;
	entity_id?: string | null;
	entity_ids?: readonly string[];
	due_before?: string;
	due_after?: string;
	query?: string;
}

/** Persistence port over user_tasks for task_crud operations. */
export interface TaskRepository {
	query(filters: TaskQueryFilters, userId?: string): Promise<UserTaskRow[]>;
	get(id: string, userId?: string): Promise<UserTaskRow>;
	insert(row: Record<string, unknown>, userId?: string): Promise<UserTaskRow>;
	update(id: string, payload: Record<string, unknown>, userId?: string): Promise<UserTaskRow>;
	deleteOne(id: string, userId?: string): Promise<string[]>;
	deleteMany(ids: string[], userId?: string): Promise<string[]>;
}

export interface TasksPort {
	taskCrud(input: TaskCrudInput, ctx?: ActionContext): Promise<TaskCrudResult>;
	createTask(input: CreateTaskInput, userId?: string): Promise<CreateTaskResult>;
}

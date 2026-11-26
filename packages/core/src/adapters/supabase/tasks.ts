import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskQueryFilters, TaskRepository, UserTaskRow } from "../../ports/tasks.js";

/** Minimal Supabase client surface required by the user_tasks adapter. */
export type TasksSupabaseClient = Pick<SupabaseClient, "from">;

/** Creates a Supabase-backed TaskRepository over the user_tasks table. */
export function createSupabaseTaskRepository(client: TasksSupabaseClient): TaskRepository {
	return {
		async query(filters: TaskQueryFilters, userId?: string): Promise<UserTaskRow[]> {
			if (filters.entity_ids && filters.entity_ids.length === 0) {
				return [];
			}
			let dbQuery = client
				.from("user_tasks")
				.select("*")
				.order("created_at", { ascending: false })
				.limit(filters.limit ?? 20);

			if (userId) dbQuery = dbQuery.eq("user_id", userId);
			if (filters.status) dbQuery = dbQuery.eq("status", filters.status);
			if (filters.priority) dbQuery = dbQuery.eq("priority", filters.priority);
			if (filters.priority_level !== undefined)
				dbQuery = dbQuery.eq("priority_level", filters.priority_level);
			if (filters.task_type) dbQuery = dbQuery.eq("task_type", filters.task_type);
			if (filters.effort) dbQuery = dbQuery.eq("effort", filters.effort);
			if (filters.energy_mode)
				dbQuery = dbQuery.eq("energy_mode", filters.energy_mode);
			if (filters.source) dbQuery = dbQuery.eq("source", filters.source);
			if (filters.entity_id) dbQuery = dbQuery.eq("entity_id", filters.entity_id);
			if (filters.entity_ids && filters.entity_ids.length > 0) {
				dbQuery = dbQuery.in("entity_id", [...filters.entity_ids]);
			}
			if (filters.due_before) dbQuery = dbQuery.lte("due_date", filters.due_before);
			if (filters.due_after) dbQuery = dbQuery.gte("due_date", filters.due_after);
			if (filters.query && filters.query.trim().length > 0) {
				dbQuery = dbQuery.ilike("title", `%${filters.query.trim()}%`);
			}

			const { data, error } = await dbQuery;
			if (error) {
				throw new Error(`Failed to query tasks: ${error.message}`);
			}
			return (data ?? []) as UserTaskRow[];
		},

		async get(id: string, userId?: string): Promise<UserTaskRow> {
			let dbQuery = client.from("user_tasks").select("*").eq("id", id);
			if (userId) dbQuery = dbQuery.eq("user_id", userId);

			const { data, error } = await dbQuery.single();
			if (error) {
				throw new Error(`Failed to get task ${id}: ${error.message}`);
			}
			return data as UserTaskRow;
		},

		async insert(row: Record<string, unknown>, _userId?: string): Promise<UserTaskRow> {
			const { data, error } = await client.from("user_tasks").insert(row).select().single();
			if (error) {
				throw new Error(`Failed to create task: ${error.message}`);
			}
			return data as UserTaskRow;
		},

		async update(id: string, payload: Record<string, unknown>, userId?: string): Promise<UserTaskRow> {
			let dbQuery = client.from("user_tasks").update(payload).eq("id", id);
			if (userId) dbQuery = dbQuery.eq("user_id", userId);

			const { data, error } = await dbQuery.select().single();
			if (error) {
				throw new Error(error.message);
			}
			return data as UserTaskRow;
		},

		async deleteOne(id: string, userId?: string): Promise<string[]> {
			let dbQuery = client.from("user_tasks").delete().eq("id", id);
			if (userId) dbQuery = dbQuery.eq("user_id", userId);

			const { data, error } = await dbQuery.select();
			if (error) {
				throw new Error(`Failed to delete task ${id}: ${error.message}`);
			}
			return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
		},

		async deleteMany(ids: string[], userId?: string): Promise<string[]> {
			let dbQuery = client.from("user_tasks").delete().in("id", ids);
			if (userId) dbQuery = dbQuery.eq("user_id", userId);

			const { data, error } = await dbQuery.select();
			if (error) {
				throw new Error(`Failed to bulk delete tasks: ${error.message}`);
			}
			return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
		},
	};
}

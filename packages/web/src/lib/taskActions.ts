import {
  taskFields,
  taskCrudSchema,
  type TaskCrudInput,
  type UserTaskRow,
  type TaskCrudResult,
} from "@ahkms/core";
import { type ClientActionDefinition } from "./actionClient.js";
import { supabase } from "./supabase.js";

export const clientTaskFields = taskFields;
export const clientTaskCrudSchema = taskCrudSchema;
export type ClientTaskCrudInput = TaskCrudInput;
export type ClientUserTaskRow = UserTaskRow;
export type ClientTaskCrudResult = TaskCrudResult;

export async function queryTasksDirect(
  input: ClientTaskCrudInput,
  userId?: string,
): Promise<ClientTaskCrudResult> {
  let dbQuery = supabase
    .from("user_tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 20);

  if (userId) {
    dbQuery = dbQuery.eq("user_id", userId);
  }

  if (input.status) {
    dbQuery = dbQuery.eq("status", input.status);
  }

  if (input.priority) {
    dbQuery = dbQuery.eq("priority", input.priority);
  }

  if (input.entity_id) {
    dbQuery = dbQuery.eq("entity_id", input.entity_id);
  }

  if (input.due_before) {
    dbQuery = dbQuery.lte("due_date", input.due_before);
  }

  if (input.due_after) {
    dbQuery = dbQuery.gte("due_date", input.due_after);
  }

  if (input.query && input.query.trim().length > 0) {
    dbQuery = dbQuery.ilike("title", `%${input.query.trim()}%`);
  }

  const { data, error } = await dbQuery;
  if (error) {
    throw new Error(`Failed to query tasks: ${error.message}`);
  }

  return {
    operation: "query",
    count: data?.length ?? 0,
    tasks: (data ?? []) as ClientUserTaskRow[],
  };
}

export async function getTaskDirect(
  id: string,
  userId?: string,
): Promise<ClientTaskCrudResult> {
  let dbQuery = supabase.from("user_tasks").select("*").eq("id", id);
  if (userId) {
    dbQuery = dbQuery.eq("user_id", userId);
  }

  const { data, error } = await dbQuery.single();
  if (error) {
    throw new Error(`Failed to get task ${id}: ${error.message}`);
  }

  return {
    operation: "get",
    task: data as ClientUserTaskRow,
  };
}

export const taskCrudActionClient: ClientActionDefinition<
  ClientTaskCrudInput,
  ClientTaskCrudResult
> = {
  id: "task_crud",
  name: "Task CRUD",
  description:
    "Create, query, get, update, complete, delete, or bulk-delete actionable user tasks in ahOS.",
  schema: clientTaskCrudSchema,
};

import {
	createCreateTaskAction,
	createTaskInput,
	createTaskSchema,
	extractNotionPageId,
	formatCreateTaskMcp,
	tomorrowDateOnly,
	type CreateTaskInput,
	type CreateTaskResult,
	type TasksPort,
} from "@ahkms/core";
import { createCoreTasksPort } from "@ahkms/core/actions";
import {
	createSupabaseArtifactRepository,
	createSupabaseConfigRepository,
	createSupabaseEntityRepository,
	createSupabaseLinkRepository,
	createSupabaseStorageAdapter,
	createSupabaseTaskRepository,
	type ArtifactSupabaseClient,
	type ConfigSupabaseClient,
	type EntitiesSupabaseClient,
	type LinksSupabaseClient,
	type StorageSupabaseClient,
	type TasksSupabaseClient,
} from "@ahkms/core/adapters";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { env } from "../env.js";
import { getCurrentUserId } from "../identity.js";
import { externalLinks } from "../links.js";
import { supabase } from "../supabase.js";
import { notionAdapter } from "./searchNotion.js";

export {
	createTaskInput,
	createTaskSchema,
	type CreateTaskInput,
	type CreateTaskResult,
	extractNotionPageId,
	formatCreateTaskMcp,
	tomorrowDateOnly,
};

let cachedTasksPort: TasksPort | null = null;

/** The server's `TasksPort`: core's bodies over the core adapters (#1662), wired here as `capture.ts` wires its own. */
export function serverTasksPort(): TasksPort {
	const ownerId = getCurrentUserId;
	cachedTasksPort ??= createCoreTasksPort({
		tasks: createSupabaseTaskRepository(supabase as unknown as TasksSupabaseClient),
		notion: notionAdapter,
		config: createSupabaseConfigRepository({ client: supabase as unknown as ConfigSupabaseClient, ownerId }),
		links: externalLinks,
		artifacts: createSupabaseArtifactRepository({ client: supabase as unknown as ArtifactSupabaseClient, ownerId }),
		storage: createSupabaseStorageAdapter({
			client: supabase as unknown as StorageSupabaseClient,
			supabaseUrl: () => env.supabaseUrl,
		}),
		entities: createSupabaseEntityRepository({ client: supabase as unknown as EntitiesSupabaseClient, ownerId }),
		entityLinks: createSupabaseLinkRepository({ client: supabase as unknown as LinksSupabaseClient, ownerId }),
		storageBucket: () => env.storageBucket,
		ownerId: () => {
			try {
				return getCurrentUserId();
			} catch {
				return undefined;
			}
		},
	});
	return cachedTasksPort;
}

/** `task_create`'s body is core's `createTaskBody.ts` (#1662); this runs it over the server's ports. */
export function createTaskCore(args: CreateTaskInput, userId?: string): Promise<CreateTaskResult> {
	return serverTasksPort().createTask(args, userId);
}

export const createTaskAction = createCreateTaskAction({ createTask: createTaskCore });

export async function createTaskHandler(
	args: CreateTaskInput,
): Promise<{ content: { type: "text"; text: string }[] }> {
	return toMcpTool(createTaskAction).handler(args);
}

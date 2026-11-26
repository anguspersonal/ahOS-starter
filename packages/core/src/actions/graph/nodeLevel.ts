import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import type { GenericSupabaseClient } from "../github/issueCreate.js";

export const graphNodeLevelInputSchema = z
	.object({
		id: z.string().uuid({ message: "Node ID must be a valid UUID" }),
		direction: z.enum(["up", "down", "set"]),
		delta: z.number().int().min(1).max(13).optional(),
		target_level: z.number().int().min(1).max(14).optional(),
	})
	.refine(
		(data) => data.direction !== "set" || typeof data.target_level === "number",
		{
			message: "target_level is required when direction is 'set'",
			path: ["target_level"],
		},
	);

export type GraphNodeLevelInput = z.infer<typeof graphNodeLevelInputSchema>;

export const graphNodeLevelOutputSchema = z.object({
	success: z.boolean(),
	id: z.string(),
	previous_level: z.number(),
	new_level: z.number(),
	direction: z.enum(["up", "down", "set"]),
	message: z.string(),
	entity: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type GraphNodeLevelOutput = z.infer<typeof graphNodeLevelOutputSchema>;

export interface GraphNodeLevelActionDependencies {
	supabase: GenericSupabaseClient;
	getUserId?: () => string;
}

export type NextZoomLevelOptions = {
	direction: "up" | "down" | "set";
	delta?: number;
	target_level?: number;
};

/**
 * Pure helper to calculate next zoom level (Level 1..14).
 * Level 1 is the apex/broadest anchor; Level 14 is the deepest detail.
 */
export function nextZoomLevel(
	current: unknown,
	directionOrOptions: "up" | "down" | "set" | NextZoomLevelOptions,
	delta?: number,
	target_level?: number,
): number {
	let currentLevel = 1;
	if (typeof current === "number" && !Number.isNaN(current)) {
		currentLevel = Math.min(14, Math.max(1, Math.round(current)));
	} else if (typeof current === "object" && current !== null) {
		const props = (current as Record<string, unknown>).properties;
		if (typeof props === "object" && props !== null) {
			const zl = (props as Record<string, unknown>).zoom_level;
			if (typeof zl === "number" && !Number.isNaN(zl)) {
				currentLevel = Math.min(14, Math.max(1, Math.round(zl)));
			}
		}
	}

	const opts: NextZoomLevelOptions =
		typeof directionOrOptions === "string"
			? { direction: directionOrOptions, delta, target_level }
			: directionOrOptions;

	const d = opts.delta ?? 1;

	if (opts.direction === "up") {
		return Math.max(1, currentLevel - d);
	}
	if (opts.direction === "down") {
		return Math.min(14, currentLevel + d);
	}
	if (opts.direction === "set") {
		return Math.min(14, Math.max(1, Math.round(opts.target_level ?? 1)));
	}
	return currentLevel;
}

export async function executeGraphNodeLevel(
	input: GraphNodeLevelInput,
	context: ActionContext,
	deps: GraphNodeLevelActionDependencies,
): Promise<GraphNodeLevelOutput> {
	const userId = context.userId ?? deps.getUserId?.();
	if (!userId) {
		throw new Error("Missing user context: userId is required.");
	}

	const { data: entityData, error: readError } = await deps.supabase
		.from("entities")
		.select("id, title, entity_type, properties")
		.eq("id", input.id)
		.eq("user_id", userId)
		.maybeSingle();

	if (readError) {
		throw new Error(readError.message);
	}
	if (!entityData) {
		const notFoundError = new Error(`Entity not found: ${input.id}`);
		(notFoundError as any).status = 404;
		throw notFoundError;
	}

	const existingProps = (entityData.properties as Record<string, unknown>) || {};
	const currentLevel =
		typeof existingProps.zoom_level === "number" && !Number.isNaN(existingProps.zoom_level)
			? Math.min(14, Math.max(1, Math.round(existingProps.zoom_level)))
			: 1;

	const newLevel = nextZoomLevel(currentLevel, {
		direction: input.direction,
		delta: input.delta,
		target_level: input.target_level,
	});

	const updatedProps = {
		...existingProps,
		zoom_level: newLevel,
	};

	const { data: updatedEntity, error: updateError } = await deps.supabase
		.from("entities")
		.update({ properties: updatedProps })
		.eq("id", input.id)
		.eq("user_id", userId)
		.select("id, title, entity_type, properties")
		.maybeSingle();

	if (updateError) {
		throw new Error(updateError.message);
	}
	if (!updatedEntity) {
		throw new Error(`Failed to update entity ${input.id}: no row returned.`);
	}

	const message =
		input.direction === "set"
			? `Node ${input.id} set to zoom level ${newLevel}`
			: `Node ${input.id} moved ${input.direction} from level ${currentLevel} to ${newLevel}`;

	return {
		success: true,
		id: input.id,
		previous_level: currentLevel,
		new_level: newLevel,
		direction: input.direction,
		message,
		entity: updatedEntity,
	};
}

export function createGraphNodeLevelAction(
	deps: GraphNodeLevelActionDependencies,
): ActionDefinition<typeof graphNodeLevelInputSchema, GraphNodeLevelOutput> {
	const action = defineAction<typeof graphNodeLevelInputSchema, GraphNodeLevelOutput>({
		id: "graph_node_level",
		name: "graph_node_level",
		description:
			"Move an entity node up or down in hierarchy zoom level (Level 1..14) or set its discrete zoom level in the ahOS knowledge graph.",
		domain: "kg",
		schema: graphNodeLevelInputSchema,
		outputSchema: graphNodeLevelOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		formatMcp(result) {
			return result.message;
		},
		async run(input, context) {
			return executeGraphNodeLevel(input, context, deps);
		},
	});

	(action as any).auditLog = true;
	return action;
}

import { defineAction } from "../defineAction.js";
import { entityCrudSchema, type EntitiesCrudResult } from "../domain/entities.js";
import type { EntitiesPort } from "../../ports/entities.js";
import { formatEntitiesCrudMcp } from "./format.js";

/**
 * Centralized CRUD Action for Entities (ADR-100, ADR-105).
 * Mirrors the agent-native framework capability model with unified validation,
 * execution context, behavioral hints, and multi-surface serialization.
 */
export function createEntityCrudAction(port: EntitiesPort) {
	return defineAction({
		id: "entity_crud",
		name: "entity_crud",
		description:
			"Centralized action for CRUD operations on entities in the knowledge graph: create, get, query, update, delete, bulk_delete, or upsert. Parks for the owner's approval when archive_only is false and more than 50 rows match.",
		domain: "kg",
		schema: entityCrudSchema,
		needsApproval: (input, ctx) =>
			(input.operation === "bulk_delete" ||
				(input.operation === "delete" &&
					Boolean(input.filter || (input.ids && input.ids.length > 1)))) &&
			input.archive_only === false &&
			!input.dry_run
				? (port.needsHardDeleteApproval?.(input, ctx.userId) ?? false)
				: false,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (args, ctx) => port.entityCrud(args, ctx),
		formatMcp: (result: EntitiesCrudResult) => {
			const includeProps = result.operation === "query" ? Boolean(result.include_properties) : false;
			return formatEntitiesCrudMcp(result, includeProps);
		},
	});
}

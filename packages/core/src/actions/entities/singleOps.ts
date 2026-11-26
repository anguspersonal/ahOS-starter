import { defineAction } from "../defineAction.js";
import { needsReviewBandApproval } from "../gate.js";
import type { ActionDefinition } from "../types.js";
import type { EntitiesPort } from "../../ports/entities.js";
import {
	createSchema,
	getSchema,
	querySchema,
	updateSchema,
	deleteSchema,
	upsertSchema,
	type EntityCreateInput,
	type EntityCreateResult,
	type EntityGetInput,
	type EntityGetResult,
	type EntityQueryInput,
	type EntityQueryResult,
	type EntityUpdateInput,
	type EntityUpdateResult,
	type EntityDeleteInput,
	type EntityDeleteResult,
	type EntityBulkDeleteResult,
	type EntityUpsertInput,
	type EntityUpsertResult,
} from "../domain/entities.js";
import {
	formatEntitiesCreateMcp,
	formatEntitiesGetMcp,
	formatEntitiesQueryMcp,
	formatEntitiesUpdateMcp,
	formatEntitiesDeleteMcp,
	formatEntitiesUpsertMcp,
} from "./format.js";
import type { z } from "zod";

export function createEntityCreateAction(
	port: EntitiesPort,
): ActionDefinition<typeof createSchema, EntityCreateResult> {
	return defineAction({
		id: "entity_create",
		name: "entity_create",
		description: "Create one or many entities.",
		domain: "kg",
		schema: createSchema,
		needsApproval: needsReviewBandApproval,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		run: async (args: EntityCreateInput, ctx) => port.entityCreate(args, ctx),
		formatMcp: formatEntitiesCreateMcp,
	});
}

export function createEntityGetAction(
	port: EntitiesPort,
): ActionDefinition<typeof getSchema, EntityGetResult> {
	return defineAction({
		id: "entity_get",
		name: "entity_get",
		description:
			"Read a single entity row by id, including its full properties JSON. entity_update replaces properties wholesale, so read here first and write the merged whole.",
		domain: "kg",
		schema: getSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		run: async (args: EntityGetInput, ctx) => port.entityGet(args, ctx),
		formatMcp: formatEntitiesGetMcp,
	});
}

export function createEntityQueryAction(
	port: EntitiesPort,
): ActionDefinition<typeof querySchema, EntityQueryResult> {
	return defineAction({
		id: "entity_query",
		name: "entity_query",
		description:
			"Read entity rows from the entities table with filtering across type, ids, team/user scope, archived state, and a broad text query. Pass include_properties to also print each row's properties JSON.",
		domain: "kg",
		schema: querySchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		run: async (args: EntityQueryInput, ctx) => port.entityQuery(args, ctx),
		formatMcp: (result) => formatEntitiesQueryMcp(result, Boolean(result.include_properties)),
	});
}

export function createEntityUpdateAction(
	port: EntitiesPort,
): ActionDefinition<typeof updateSchema, EntityUpdateResult> {
	return defineAction({
		id: "entity_update",
		name: "entity_update",
		description: "Update one or many entities by ids or filter criteria.",
		domain: "kg",
		schema: updateSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		run: async (args: EntityUpdateInput, ctx) => port.entityUpdate(args, ctx),
		formatMcp: formatEntitiesUpdateMcp,
	});
}

export function createEntityDeleteAction(
	port: EntitiesPort,
): ActionDefinition<typeof deleteSchema, EntityDeleteResult | EntityBulkDeleteResult> {
	return defineAction({
		id: "entity_delete",
		name: "entity_delete",
		description:
			"Delete or archive one or many entities by ids or filter criteria. Parks for the owner's approval when archive_only is false and more than 50 rows match.",
		domain: "kg",
		schema: deleteSchema,
		needsApproval: (input, ctx) =>
			input.archive_only === false && !input.dry_run
				? (port.needsHardDeleteApproval?.(input, ctx.userId) ?? false)
				: false,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		run: async (args: z.infer<typeof deleteSchema>, ctx) => {
			if (args.filter || args.dry_run || (args.ids && args.ids.length > 1)) {
				return port.entityBulkDelete(args, ctx);
			}
			if (args.ids && args.ids.length === 1) {
				return port.entityDelete({ id: args.ids[0], archive_only: args.archive_only }, ctx);
			}
			return port.entityBulkDelete(args, ctx);
		},
		formatMcp: formatEntitiesDeleteMcp,
	});
}

export function createEntityUpsertAction(
	port: EntitiesPort,
): ActionDefinition<typeof upsertSchema, EntityUpsertResult> {
	return defineAction({
		id: "entity_upsert",
		name: "entity_upsert",
		description: "Create or update one or many entities. If id is supplied, updates that row; otherwise creates a new row.",
		domain: "kg",
		schema: upsertSchema,
		needsApproval: needsReviewBandApproval,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		run: async (args: EntityUpsertInput, ctx) => port.entityUpsert(args, ctx),
		formatMcp: formatEntitiesUpsertMcp,
	});
}

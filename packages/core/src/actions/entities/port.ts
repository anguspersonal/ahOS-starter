import type { EntitiesPort } from "../../ports/entities.js";
import {
	entitiesCreateCore,
	entitiesDeleteCore,
	entitiesGetCore,
	entitiesQueryCore,
	entitiesUpdateCore,
	entitiesUpsertCore,
	entityBulkDeleteRun,
	entityCrudRun,
	entityHardDeleteNeedsApproval,
	type CoreEntitiesDeps,
} from "./core.js";

export function createCoreEntitiesPort(deps: CoreEntitiesDeps): EntitiesPort {
	return {
		entityCrud: (args, ctx) => entityCrudRun(deps, args, ctx),
		entityBulkDelete: (args, ctx) => entityBulkDeleteRun(deps, args, ctx),
		entityCreate: (args, ctx) => entitiesCreateCore(deps, args, ctx?.userId),
		entityGet: (args, ctx) => entitiesGetCore(deps, args, ctx?.userId),
		entityQuery: async (args, ctx) => {
			const res = await entitiesQueryCore(deps, args, ctx?.userId);
			return { ...res, include_properties: args.include_properties ?? false };
		},
		entityUpdate: (args, ctx) => entitiesUpdateCore(deps, args, ctx?.userId),
		entityDelete: (args, ctx) =>
			entitiesDeleteCore(deps, { ids: [args.id], archive_only: args.archive_only }, ctx?.userId),
		entityUpsert: (args, ctx) => entitiesUpsertCore(deps, args, ctx?.userId),
		needsHardDeleteApproval: (input, userId) =>
			entityHardDeleteNeedsApproval(deps, input, userId),
	};
}

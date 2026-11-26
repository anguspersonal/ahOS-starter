import type { EntityRepository } from "../../ports/entities.js";
import type { RelationshipsPort } from "../../ports/relationships.js";
import { relationshipCrudCore } from "./relationshipCrudBody.js";

export interface CoreRelationshipsPortDeps {
	entities: EntityRepository;
}

export function createCoreRelationshipsPort(
	deps: CoreRelationshipsPortDeps,
): RelationshipsPort {
	return {
		relationshipCrud: (input, ctx) => relationshipCrudCore(deps.entities, input, ctx),
	};
}

import {
	createRelationshipCrudAction,
	relationshipRoleEnum,
	relationshipCrudSchema,
	resolveRelationshipEndpoints,
	type RelationshipCrudInput,
	type RelationshipRecord,
	type RelationshipCrudOutput,
} from "@ahkms/core";
import { createCoreRelationshipsPort } from "@ahkms/core/actions";
import {
	createSupabaseEntityRepository,
	type EntitiesSupabaseClient,
} from "@ahkms/core/adapters";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";

export {
	relationshipRoleEnum,
	relationshipCrudSchema,
	type RelationshipCrudInput,
	type RelationshipRecord,
	type RelationshipCrudOutput,
	resolveRelationshipEndpoints,
};

function resolveCurrentUserId(): string | undefined {
	try {
		return getCurrentUserId();
	} catch {
		return undefined;
	}
}

export const relationshipsPort = createCoreRelationshipsPort({
	entities: createSupabaseEntityRepository({
		client: supabase as unknown as EntitiesSupabaseClient,
		ownerId: resolveCurrentUserId,
	}),
});

export const relationshipCrudAction = createRelationshipCrudAction(relationshipsPort);

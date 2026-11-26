import type { EntityRepository } from "../../ports/entities.js";
import { AdapterUnavailableError } from "../buildRegistry.js";
import {
	relationshipCrudSchema,
	relationshipRoleEnum,
	resolveRelationshipEndpoints,
	type RelationshipCrudInput,
	type RelationshipCrudOutput,
	type RelationshipRecord,
} from "../domain/relationships.js";
import type { ActionContext } from "../types.js";

export {
	relationshipRoleEnum,
	relationshipCrudSchema,
	resolveRelationshipEndpoints,
	type RelationshipCrudInput,
	type RelationshipRecord,
	type RelationshipCrudOutput,
};

export async function relationshipCrudCore(
	entities: EntityRepository,
	input: RelationshipCrudInput,
	ctx?: Partial<ActionContext>,
): Promise<RelationshipCrudOutput> {
	const userId: string | undefined = ctx?.userId || undefined;
	const operation = input.operation;

	switch (operation) {
		case "create": {
			let fromId = input.from_entity_id;
			let toId = input.to_entity_id;
			let relType = input.relationship_type;

			if (!fromId || !toId) {
				throw new Error("Both from_entity_id and to_entity_id are required to create a relationship");
			}
			if (fromId === toId) {
				throw new Error("Cannot create self-referencing relationship: from and to IDs must differ");
			}

			if (input.role) {
				const resolved = resolveRelationshipEndpoints(fromId, toId, input.role, relType);
				fromId = resolved.fromId;
				toId = resolved.toId;
				relType = resolved.relType;
			} else if (!relType) {
				relType = "relates_to";
			}

			if (!entities.insertRelationship) {
				throw new AdapterUnavailableError("entities.insertRelationship is not wired");
			}

			const newId = input.id || globalThis.crypto.randomUUID();
			const row = {
				id: newId,
				from_entity_id: fromId,
				to_entity_id: toId,
				relationship_type: relType,
				confidence_score: input.confidence_score ?? 1.0,
				metadata: input.metadata || {},
			};

			const data = userId
				? await entities.insertRelationship(row, userId)
				: await entities.insertRelationship(row);

			return {
				success: true,
				operation: "create",
				id: data.id,
				count: 1,
				relationship: data,
				message: `Created relationship '${data.relationship_type}' between ${data.from_entity_id} and ${data.to_entity_id}`,
			};
		}

		case "get": {
			if (!input.id) {
				throw new Error("Relationship ID is required for 'get' operation");
			}
			if (!entities.getRelationship) {
				throw new AdapterUnavailableError("entities.getRelationship is not wired");
			}

			const data = userId
				? await entities.getRelationship(input.id, userId)
				: await entities.getRelationship(input.id);

			return {
				success: !!data,
				operation: "get",
				id: input.id,
				count: data ? 1 : 0,
				relationship: data || null,
				message: data ? `Found relationship '${data.relationship_type}'` : `Relationship ${input.id} not found`,
			};
		}

		case "query": {
			if (!entities.queryRelationships) {
				throw new AdapterUnavailableError("entities.queryRelationships is not wired");
			}

			const filter = {
				entity_id: input.filter?.entity_id,
				direction: input.filter?.direction || "both",
				relationship_type: input.filter?.relationship_type,
				limit: input.filter?.limit ?? 50,
			};

			const records = userId
				? await entities.queryRelationships(filter, userId)
				: await entities.queryRelationships(filter);

			return {
				success: true,
				operation: "query",
				count: records.length,
				relationships: records,
				message: `Found ${records.length} relationships`,
			};
		}

		case "update": {
			if (!input.id) {
				throw new Error("Relationship ID is required for 'update' operation");
			}
			if (!entities.updateRelationship) {
				throw new AdapterUnavailableError("entities.updateRelationship is not wired");
			}

			const patch: {
				updated_at: string;
				relationship_type?: string;
				confidence_score?: number;
				metadata?: Record<string, unknown>;
			} = {
				updated_at: new Date().toISOString(),
			};
			if (input.relationship_type !== undefined) patch.relationship_type = input.relationship_type;
			if (input.confidence_score !== undefined) patch.confidence_score = input.confidence_score;
			if (input.metadata !== undefined) patch.metadata = input.metadata;

			const data = userId
				? await entities.updateRelationship(input.id, patch, userId)
				: await entities.updateRelationship(input.id, patch);

			return {
				success: !!data,
				operation: "update",
				id: input.id,
				count: data ? 1 : 0,
				relationship: data || null,
				message: data ? `Updated relationship ${input.id}` : `Relationship ${input.id} not found for update`,
			};
		}

		case "delete": {
			if (!input.id && (!input.from_entity_id || !input.to_entity_id)) {
				throw new Error("Must provide either 'id' or both 'from_entity_id' and 'to_entity_id' for 'delete' operation");
			}
			if (!entities.deleteRelationships) {
				throw new AdapterUnavailableError("entities.deleteRelationships is not wired");
			}

			const target = input.id
				? { id: input.id }
				: {
						from_entity_id: input.from_entity_id!,
						to_entity_id: input.to_entity_id!,
						...(input.relationship_type ? { relationship_type: input.relationship_type } : {}),
					};

			if (userId) {
				await entities.deleteRelationships(target, userId);
			} else {
				await entities.deleteRelationships(target);
			}

			return {
				success: true,
				operation: "delete",
				id: input.id,
				deleted: true,
				message: `Deleted relationship edge successfully`,
			};
		}
	}
}

import { defineAction } from "../defineAction.js";
import {
	relationshipCrudSchema,
	type RelationshipCrudInput,
	type RelationshipCrudOutput,
} from "../domain/relationships.js";
import type { RelationshipsPort } from "../../ports/relationships.js";
import type { ActionContext } from "../types.js";

export function createRelationshipCrudAction(
	port: RelationshipsPort | Pick<RelationshipsPort, "relationshipCrud">,
) {
	return defineAction({
		id: "relationship_crud",
		name: "relationship_crud",
		description:
			"Perform CRUD operations on entity relationship edges in the ahOS knowledge graph, including adding parent, child, or sibling links between nodes.",
		domain: "kg",
		schema: relationshipCrudSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		expose: {
			mcp: false,
			reason: "owner_decision_pending",
			note: "web-only until the owner chooses between it and entity_relate on MCP",
		},
		run: async (input: RelationshipCrudInput, ctx?: ActionContext) => {
			return port.relationshipCrud(input, ctx);
		},
		formatMcp(result: RelationshipCrudOutput) {
			return result.message;
		},
	});
}

import {
  relationshipRoleEnum,
  relationshipCrudSchema,
  type RelationshipCrudInput,
  type RelationshipRecord,
  type RelationshipCrudOutput,
} from "@ahkms/core";
import { type ClientActionDefinition, executeActionClient } from "./actionClient.js";
import { supabase } from "./supabase.js";

export {
  relationshipRoleEnum,
  relationshipCrudSchema,
  type RelationshipCrudInput,
  type RelationshipRecord,
  type RelationshipCrudOutput,
};

export type RelationshipListener = (output: RelationshipCrudOutput) => void;
const relationshipListeners = new Set<RelationshipListener>();

export function registerRelationshipListener(listener: RelationshipListener): () => void {
  relationshipListeners.add(listener);
  return () => {
    relationshipListeners.delete(listener);
  };
}

/**
 * Resolves source, target, and relationship type based on role (parent, child, sibling, custom).
 */
export function resolveRelationshipEndpoints(
  focalId: string,
  targetId: string,
  role: "parent" | "child" | "sibling" | "custom" = "custom",
  customType?: string,
): { fromId: string; toId: string; relType: string } {
  if (role === "child") {
    // Focal node is the parent, target is the child
    return {
      fromId: focalId,
      toId: targetId,
      relType: customType || "contains",
    };
  }
  if (role === "parent") {
    // Target node is the parent, focal is the child
    return {
      fromId: targetId,
      toId: focalId,
      relType: customType || "contains",
    };
  }
  if (role === "sibling") {
    // Peer/sibling link
    return {
      fromId: focalId,
      toId: targetId,
      relType: customType || "siblingOf",
    };
  }
  return {
    fromId: focalId,
    toId: targetId,
    relType: customType || "relates_to",
  };
}

/**
 * Direct read from Supabase under RLS for low-latency queries (#1317, #1325).
 */
export async function queryRelationshipsDirect(input: {
  entity_id?: string;
  from_entity_id?: string;
  to_entity_id?: string;
  direction?: "outgoing" | "incoming" | "both";
  relationship_type?: string;
  limit?: number;
}): Promise<RelationshipCrudOutput> {
  const entityId = input.entity_id || input.from_entity_id || input.to_entity_id;
  const direction = input.direction || "both";
  const limit = input.limit || 50;

  let q = supabase.from("entity_relationships").select("*");
  if (entityId) {
    if (direction === "outgoing") {
      q = q.eq("from_entity_id", entityId);
    } else if (direction === "incoming") {
      q = q.eq("to_entity_id", entityId);
    } else {
      q = q.or(`from_entity_id.eq.${entityId},to_entity_id.eq.${entityId}`);
    }
  } else {
    if (input.from_entity_id) q = q.eq("from_entity_id", input.from_entity_id);
    if (input.to_entity_id) q = q.eq("to_entity_id", input.to_entity_id);
  }
  if (input.relationship_type) {
    q = q.eq("relationship_type", input.relationship_type);
  }
  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    throw new Error(`Failed to query relationships: ${error.message}`);
  }

  const relationships = (data ?? []) as RelationshipRecord[];
  return {
    success: true,
    operation: "query",
    count: relationships.length,
    relationships,
    message: `Found ${relationships.length} relationship(s)`,
  };
}

/**
 * Direct get from Supabase under RLS (#1325).
 */
export async function getRelationshipDirect(id: string): Promise<RelationshipCrudOutput> {
  const { data, error } = await supabase
    .from("entity_relationships")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    throw new Error(`Failed to get relationship ${id}: ${error.message}`);
  }

  return {
    success: true,
    operation: "get",
    id,
    count: 1,
    relationship: data as RelationshipRecord,
    message: `Found relationship ${id}`,
  };
}

/**
 * Client Action Definition for Entity Relationship CRUD in Centralised Action Registry (CAR).
 * In production, mutations route through CAR on the server (/api/actions/relationship_crud).
 * Client action has no local run handler (ADR-101 #1325).
 */
export const relationshipCrudActionClient: ClientActionDefinition<
  RelationshipCrudInput,
  RelationshipCrudOutput
> = {
  id: "relationship_crud",
  name: "relationship_crud",
  description:
    "Perform CRUD operations on entity relationship edges in the ahOS knowledge graph, including adding parent, child, or sibling links between nodes.",
  schema: relationshipCrudSchema,
};

export async function executeRelationshipCrud(
  input: RelationshipCrudInput,
): Promise<RelationshipCrudOutput> {
  const validatedInput = { ...input };
  if (validatedInput.operation === "create") {
    if (!validatedInput.from_entity_id || !validatedInput.to_entity_id) {
      throw new Error("Both from_entity_id and to_entity_id are required to create a relationship");
    }
    if (validatedInput.from_entity_id === validatedInput.to_entity_id) {
      throw new Error("Cannot create self-referencing relationship: from and to IDs must differ");
    }
    if (validatedInput.role) {
      const resolved = resolveRelationshipEndpoints(
        validatedInput.from_entity_id,
        validatedInput.to_entity_id,
        validatedInput.role,
        validatedInput.relationship_type,
      );
      validatedInput.from_entity_id = resolved.fromId;
      validatedInput.to_entity_id = resolved.toId;
      validatedInput.relationship_type = resolved.relType;
    } else if (!validatedInput.relationship_type) {
      validatedInput.relationship_type = "relates_to";
    }
  }

  const output = await executeActionClient(relationshipCrudActionClient, validatedInput);
  for (const listener of relationshipListeners) {
    listener(output);
  }
  return output;
}

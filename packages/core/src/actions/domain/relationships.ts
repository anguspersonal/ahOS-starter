import { z } from "zod";

export const relationshipRoleEnum = z.enum(["parent", "child", "sibling", "custom"]);
export type RelationshipRole = z.infer<typeof relationshipRoleEnum>;

export const relationshipCrudSchema = z.object({
	operation: z.enum(["create", "get", "query", "update", "delete"]),
	id: z.string().uuid().optional(),
	from_entity_id: z.string().uuid().optional(),
	to_entity_id: z.string().uuid().optional(),
	relationship_type: z.string().min(1).optional(),
	role: relationshipRoleEnum.optional(),
	confidence_score: z.number().min(0).max(1).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	filter: z
		.object({
			entity_id: z.string().uuid().optional(),
			direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both"),
			relationship_type: z.string().optional(),
			limit: z.number().int().min(1).max(200).optional().default(50),
		})
		.optional(),
});

export type RelationshipCrudInput = z.input<typeof relationshipCrudSchema>;

export interface RelationshipRecord {
	id: string;
	from_entity_id: string;
	to_entity_id: string;
	relationship_type: string;
	confidence_score?: number;
	metadata?: Record<string, unknown>;
	created_at?: string;
	updated_at?: string;
	[key: string]: unknown;
}

export interface RelationshipCrudOutput {
	success: boolean;
	operation: "create" | "get" | "query" | "update" | "delete";
	id?: string;
	count?: number;
	relationship?: RelationshipRecord | null;
	relationships?: RelationshipRecord[];
	deleted?: boolean;
	message: string;
}

export function resolveRelationshipEndpoints(
	focalId: string,
	targetId: string,
	role: "parent" | "child" | "sibling" | "custom" = "custom",
	customType?: string,
): { fromId: string; toId: string; relType: string } {
	if (role === "child") {
		return { fromId: focalId, toId: targetId, relType: customType || "contains" };
	}
	if (role === "parent") {
		return { fromId: targetId, toId: focalId, relType: customType || "contains" };
	}
	if (role === "sibling") {
		return { fromId: focalId, toId: targetId, relType: customType || "siblingOf" };
	}
	return { fromId: focalId, toId: targetId, relType: customType || "relates_to" };
}

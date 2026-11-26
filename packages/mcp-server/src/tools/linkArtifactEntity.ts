import { z } from "zod";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { linkType } from "../vocab.js";

export const linkArtifactEntityInput = {
	artifact_id: z.string().uuid().describe("Artifact id (from capture or search)."),
	entity_id: z.string().uuid().describe("Entity id (from upsert_entity)."),
	link_type: linkType
		.default("related")
		.describe(
			"'primary' (the artifact is chiefly about this entity), 'mentioned', or 'related'. This provenance/lineage edge lets the graph explain where a fact came from and counts as an interaction.",
		),
	confidence: z.number().min(0).max(100).optional(),
	notes: z.string().optional(),
};

const linkArtifactEntitySchema = z.object(linkArtifactEntityInput);

export async function linkArtifactEntityHandler(
	args: z.infer<typeof linkArtifactEntitySchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	// Ownership: both ends must be the user's (service-role bypasses RLS).
	const { data: entity, error: entErr } = await supabase
		.from("entities")
		.select("id")
		.eq("id", args.entity_id)
		.eq("user_id", getCurrentUserId())
		.maybeSingle();
	if (entErr) throw new Error(`Entity check failed: ${entErr.message}`);
	if (!entity) throw new Error(`Entity ${args.entity_id} not found or not yours.`);

	const { data: artifact, error: artErr } = await supabase
		.from("artifacts")
		.select("id")
		.eq("id", args.artifact_id)
		.eq("user_id", getCurrentUserId())
		.maybeSingle();
	if (artErr) throw new Error(`Artifact check failed: ${artErr.message}`);
	if (!artifact) throw new Error(`Artifact ${args.artifact_id} not found or not yours.`);

	// Upsert on the user-scoped unique (user_id, artifact_id, entity_id, link_type)
	// key — widened by migration 052 so conflict detection is owner-correct.
	const { error } = await supabase.from("artifact_entity_links").upsert(
		{
			user_id: getCurrentUserId(),
			artifact_id: args.artifact_id,
			entity_id: args.entity_id,
			link_type: args.link_type,
			confidence_score: args.confidence ?? null,
			created_by: "mcp",
			notes: args.notes ?? null,
		},
		{ onConflict: "user_id,artifact_id,entity_id,link_type" },
	);
	if (error) throw new Error(`Link failed: ${error.message}`);
	return {
		content: [
			{
				type: "text",
				text: `Linked artifact ${args.artifact_id} -[${args.link_type}]-> entity ${args.entity_id}.`,
			},
		],
	};
}

/**
 * @ahkms/core/adapters - Supabase persistence ports for entity synthesis
 * (ADR-101 §3, #1353).
 *
 * Uses the real `@supabase/supabase-js` client. Every method throws on a
 * PostgREST error.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
	EntitySynthesizePorts,
	SynthesizeArtifactRecord,
	SynthesizeDecisionRecord,
	SynthesizeEntityRecord,
} from "../../actions/domain/synthesizePorts.js";

export type SynthesizeSupabaseClient = Pick<SupabaseClient, "from">;

const ARTIFACT_ENTITY_LINKS_TABLE = "artifact_entity_links";
const ENTITIES_TABLE = "entities";
const ARTIFACTS_TABLE = "artifacts";
const SYSTEM_DECISIONS_TABLE = "system_decisions";

function fail(what: string, error: { message: string } | null): never {
	throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
}

export function createSupabaseSynthesizePorts(
	client: SynthesizeSupabaseClient,
): Omit<EntitySynthesizePorts, "generate"> {
	return {
		async fetchEntity(userId: string, entityId: string): Promise<SynthesizeEntityRecord | null> {
			const { data, error } = await client
				.from(ENTITIES_TABLE)
				.select("id, title, entity_type, description, properties, updated_at")
				.eq("id", entityId)
				.eq("user_id", userId)
				.eq("archived", false)
				.maybeSingle();

			if (error) fail("fetchEntity failed", error);
			if (!data) return null;
			return data as unknown as SynthesizeEntityRecord;
		},

		async fetchLinkedArtifacts(
			userId: string,
			entityId: string,
			limit: number,
		): Promise<SynthesizeArtifactRecord[]> {
			const { data: links, error: linkErr } = await client
				.from(ARTIFACT_ENTITY_LINKS_TABLE)
				.select("artifact_id")
				.eq("entity_id", entityId)
				.eq("user_id", userId)
				.limit(limit);

			if (linkErr) fail("fetchLinkedArtifacts link query failed", linkErr);
			if (!links || links.length === 0) return [];

			const artifactIds = links.map((l: { artifact_id: string }) => l.artifact_id);
			const { data: artifacts, error: artErr } = await client
				.from(ARTIFACTS_TABLE)
				.select("id, title, plain_text")
				.in("id", artifactIds)
				.eq("user_id", userId)
				.eq("archived", false);

			if (artErr) fail("fetchLinkedArtifacts artifact query failed", artErr);
			return (artifacts ?? []) as unknown as SynthesizeArtifactRecord[];
		},

		async updateEntityProfile(
			userId: string,
			update: {
				entityId: string;
				description: string;
				properties: Record<string, unknown>;
				expectedUpdatedAt: string;
			},
		): Promise<boolean> {
			const { data, error } = await client
				.from(ENTITIES_TABLE)
				.update({
					description: update.description,
					properties: update.properties,
					updated_at: new Date().toISOString(),
				})
				.eq("id", update.entityId)
				.eq("user_id", userId)
				.eq("updated_at", update.expectedUpdatedAt)
				.select("id");

			if (error) fail("updateEntityProfile failed", error);
			return Boolean(data && data.length > 0);
		},

		async recordDecision(decision: SynthesizeDecisionRecord): Promise<void> {
			const { error } = await client.from(SYSTEM_DECISIONS_TABLE).insert([
				{
					user_id: decision.userId,
					decision_type: "entity_synthesize",
					stage: "refine",
					title: `Synthesized profile for entity ${decision.entityId}`,
					description: `${decision.provider}:${decision.model} synthesized profile from ${decision.artifactIds.length} artifacts (outcome: ${decision.outcome}).`,
					confidence_score: null,
					blocking: false,
					user_visible: false,
					requires_user_action: false,
					review_type: "suggestion",
					status: "auto_applied",
					decision_payload: {
						entity_id: decision.entityId,
						artifact_ids: decision.artifactIds,
						provider: decision.provider,
						model: decision.model,
						outcome: decision.outcome,
						profile: decision.profile,
						error: decision.error,
					},
				},
			]);

			if (error) fail("system_decisions insert failed", error);
		},
	};
}

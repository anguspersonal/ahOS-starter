/**
 * @ahkms/core/adapters - Supabase persistence ports for entity derivation
 * (ADR-101 §3, #1306).
 *
 * Uses the real `@supabase/supabase-js` client. Every method throws on a
 * PostgREST error; nothing is swallowed. Table and conflict-target names mirror
 * the live schema (`artifact_entity_links`, `entity_relationships`).
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CandidateArtifact, ExtractedEntity } from "../../actions/domain/derive.js";
import type {
	DerivationRecord,
	DeriveDecisionRecord,
	EntityDerivePorts,
} from "../../actions/domain/derivePorts.js";
import { classifyDecisionConfidenceBand } from "../../ports/decisionJudge.js";

export type DeriveSupabaseClient = Pick<SupabaseClient, "from" | "rpc">;

export const ARTIFACT_COLUMNS =
	"id,title,description,plain_text,content_subtype,lifecycle_stage,surface,trust_override,processing_metadata";

/** PostgREST `or` filter: derivation status absent, or neither completed nor skipped. */
export const UNDERIVED_FILTER =
	"processing_metadata->derivation->>status.is.null,processing_metadata->derivation->>status.not.in.(completed,skipped)";

export const ARTIFACT_ENTITY_LINKS_TABLE = "artifact_entity_links";
export const ARTIFACT_ENTITY_LINKS_CONFLICT = "user_id,artifact_id,entity_id,link_type";
export const ENTITY_RELATIONSHIPS_TABLE = "entity_relationships";
export const ENTITY_RELATIONSHIPS_CONFLICT = "user_id,from_entity_id,to_entity_id,relationship_type";
export const DERIVE_LINK_TYPE = "mentioned";
export const DERIVE_CREATED_BY = "entity_derive";

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function fail(what: string, error: { message: string } | null): never {
	throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
}

export function createSupabaseDerivePorts(
	client: DeriveSupabaseClient,
): Omit<EntityDerivePorts, "generate"> {
	return {
		async fetchCandidatePage({ userId, offset, pageSize }): Promise<CandidateArtifact[]> {
			const { data, error } = await client
				.from("artifacts")
				.select(ARTIFACT_COLUMNS)
				.eq("user_id", userId)
				.eq("archived", false)
				.neq("lifecycle_stage", "discovered")
				.not("plain_text", "is", null)
				.or(UNDERIVED_FILTER)
				.order("created_at", { ascending: false })
				.range(offset, offset + pageSize - 1);
			if (error) fail("Failed to query candidate artifacts", error);
			return (data ?? []) as unknown as CandidateArtifact[];
		},

		async fetchArtifactsByIds(userId, ids): Promise<CandidateArtifact[]> {
			if (ids.length === 0) return [];
			const { data, error } = await client
				.from("artifacts")
				.select(ARTIFACT_COLUMNS)
				.eq("user_id", userId)
				.in("id", ids);
			if (error) fail("Failed to fetch artifacts by id", error);
			return (data ?? []) as unknown as CandidateArtifact[];
		},

		async countUnderived(userId): Promise<number> {
			const { count, error } = await client
				.from("artifacts")
				.select("id", { count: "exact", head: true })
				.eq("user_id", userId)
				.eq("archived", false)
				.neq("lifecycle_stage", "discovered")
				.not("plain_text", "is", null)
				.or(UNDERIVED_FILTER);
			if (error) fail("Failed to count underived artifacts", error);
			return count ?? 0;
		},

		async findEntity(userId, entityType, title): Promise<string | null> {
			// Exact equality, never a pattern match: LLM-derived titles must not
			// act as wildcards (#1306 H2).
			const { data, error } = await client
				.from("entities")
				.select("id")
				.eq("user_id", userId)
				.eq("entity_type", entityType)
				.eq("title", title)
				.eq("archived", false)
				.limit(1);
			if (error) fail(`Entity lookup failed for "${title}"`, error);
			const row = (data ?? [])[0] as { id: string } | undefined;
			return row?.id ?? null;
		},

		async createEntity(userId, entity: ExtractedEntity): Promise<string> {
			const id = randomUUID();
			const { error } = await client.from("entities").insert([
				{
					id,
					user_id: userId,
					team_id: null,
					entity_type: entity.entity_type,
					title: entity.title,
					description: entity.description ?? null,
					tags: [],
					archived: false,
					archived_at: null,
					properties: entity.properties ?? {},
				},
			]);
			if (error) {
				// Atomic find-or-create (#1352 / ADR-101 / migration 129):
				// If a concurrent run or sync inserted an entity with the same
				// (user_id, entity_type, lower(trim(title))), catch unique_violation (23505)
				// and resolve the existing entity instead of throwing.
				if ((error as { code?: string }).code === "23505") {
					const existingId = await this.findEntity(userId, entity.entity_type, entity.title);
					if (existingId) return existingId;
					// Fallback in case of case-difference between conflicting entities
					const escaped = entity.title.trim().replace(/[\\%_]/g, "\\$&");
					const { data: ilikeData, error: ilikeError } = await client
						.from("entities")
						.select("id")
						.eq("user_id", userId)
						.eq("entity_type", entity.entity_type)
						.ilike("title", escaped)
						.eq("archived", false)
						.limit(1);
					if (!ilikeError && ilikeData?.[0]?.id) {
						return (ilikeData[0] as { id: string }).id;
					}
				}
				fail(`Entity create failed for "${entity.title}"`, error);
			}
			return id;
		},

		async linkArtifactEntity(userId, artifactId, entityId, confidence): Promise<void> {
			const { error } = await client.from(ARTIFACT_ENTITY_LINKS_TABLE).upsert(
				[
					{
						user_id: userId,
						artifact_id: artifactId,
						entity_id: entityId,
						link_type: DERIVE_LINK_TYPE,
						confidence_score: round2(confidence),
						created_by: DERIVE_CREATED_BY,
						notes: null,
					},
				],
				{ onConflict: ARTIFACT_ENTITY_LINKS_CONFLICT },
			);
			if (error) fail("Artifact-entity link failed", error);
		},

		async createRelationship(userId, rel): Promise<void> {
			const { error } = await client.from(ENTITY_RELATIONSHIPS_TABLE).upsert(
				[
					{
						id: randomUUID(),
						user_id: userId,
						from_entity_id: rel.fromEntityId,
						to_entity_id: rel.toEntityId,
						relationship_type: rel.relationshipType,
						confidence_score: round2(rel.confidence),
						metadata: { source: DERIVE_CREATED_BY, artifact_id: rel.artifactId },
					},
				],
				{ onConflict: ENTITY_RELATIONSHIPS_CONFLICT, ignoreDuplicates: true },
			);
			if (error) fail("Relationship create failed", error);
		},

		async saveDerivation(userId, artifactId, derivation: DerivationRecord): Promise<void> {
			// Merges only the `derivation` key (migration 127), so concurrent writers
			// to other processing_metadata keys are not clobbered (#1306 M1).
			const { data, error } = await client.rpc("set_artifact_derivation", {
				p_user_id: userId,
				p_artifact_id: artifactId,
				p_derivation: derivation,
			});
			if (error) fail("Failed to save derivation status", error);
			if (Number(data) !== 1) {
				throw new Error(`Failed to save derivation status: no artifact row updated for ${artifactId}`);
			}
		},

		async recordDecision(decision: DeriveDecisionRecord): Promise<void> {
			const created = decision.entities.filter((e) => e.created).length;
			const confidenceScore = decision.confidence === null ? null : round2(decision.confidence);
			const band =
				decision.confidence_band ??
				(confidenceScore === null ? "auto_applied" : classifyDecisionConfidenceBand(confidenceScore));
			const isPending = (decision.status ?? band) === "pending";
			const status = decision.status ?? (isPending ? "pending" : "auto_applied");
			const requiresUserAction = decision.requires_user_action ?? isPending;
			const userVisible = decision.user_visible ?? isPending;
			const reviewType = decision.review_type ?? (isPending ? "clarification" : "suggestion");
			const { error } = await client.from("system_decisions").insert([
				{
					user_id: decision.userId,
					artifact_id: decision.artifactId,
					decision_type: "entity_derive",
					stage: "extract",
					title: `Derived ${decision.entities.length} entities and ${decision.relationships.length} relationships`,
					description: `${decision.provider}:${decision.model} created ${created} new entities and linked ${decision.entities.length} to the artifact.`,
					confidence_score: confidenceScore,
					blocking: false,
					user_visible: userVisible,
					requires_user_action: requiresUserAction,
					review_type: reviewType,
					status,
					decision_payload: {
						provider: decision.provider,
						model: decision.model,
						entities: decision.entities,
						relationships: decision.relationships,
						...(decision.judge_probabilities ? { judge_probabilities: decision.judge_probabilities } : {}),
					},
				},
			]);
			if (error) fail("system_decisions insert failed", error);
		},
	};
}

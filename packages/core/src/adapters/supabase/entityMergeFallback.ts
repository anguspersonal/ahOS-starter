import type { SupabaseClient } from "@supabase/supabase-js";
import type { EntityMergeRecord } from "../../domain/entityMerge.js";
import type { EntityMergeRow } from "../../ports/entityMerge.js";

export type EntityMergeFallbackClient = Pick<SupabaseClient, "from">;

export interface ClientSideMergeParams {
	winnerId: string;
	loserId: string;
	userId?: string;
	winnerRow: EntityMergeRow;
	loserRow: EntityMergeRow;
	finalWinnerProps: Record<string, unknown>;
	winnerAliases: string[];
	aliasesAdded: string[];
	propertiesCarried: string[];
	propertiesSkipped: Record<string, string>;
	decisionId?: string;
	resolutionNotes: string;
	survivorOverridden: boolean;
	payload?: Record<string, unknown>;
	nowIso: string;
}

/**
 * Checks if a Supabase RPC error is caused by a missing database function
 * or missing PostgREST schema cache entry (e.g. unpushed migration).
 */
export function isRpcMissingError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { code?: string; message?: string; details?: string };
	if (e.code === "PGRST202" || e.code === "42883") return true;
	const msg = (e.message || "").toLowerCase();
	const details = (e.details || "").toLowerCase();
	return (
		msg.includes("schema cache") ||
		msg.includes("could not find the function") ||
		(msg.includes("function") && msg.includes("does not exist")) ||
		details.includes("schema cache") ||
		details.includes("could not find the function")
	);
}

/**
 * Executes an entity merge client-side when the transactional merge_entities RPC
 * is not yet available in the database schema cache (issue #1367).
 * Maintains exact parity with migration 126 transactional merge_entities logic.
 */
export async function executeClientSideEntityMerge(
	supabase: EntityMergeFallbackClient,
	params: ClientSideMergeParams,
	ownerId?: string | (() => string),
): Promise<EntityMergeRecord> {
	const {
		winnerId,
		loserId,
		winnerRow,
		loserRow,
		finalWinnerProps,
		winnerAliases,
		aliasesAdded,
		propertiesCarried,
		propertiesSkipped,
		decisionId,
		resolutionNotes,
		survivorOverridden,
		payload,
		nowIso,
	} = params;
	const userId =
		params.userId ||
		(typeof ownerId === "function" ? ownerId() : ownerId) ||
		"";

	const movedEdgeIds: string[] = [];
	const archivedEdgeIds: string[] = [];
	const demotedEdgeTypes: Record<string, string> = {};
	const linksMoved: string[] = [];
	const linksDeleted: string[] = [];

	// 1. Repoint relationship edges touching loser
	const { data: rawEdges, error: edgesErr } = await supabase
		.from("entity_relationships")
		.select("*")
		.or(`from_entity_id.eq.${loserId},to_entity_id.eq.${loserId}`)
		.eq("user_id", userId);

	if (edgesErr) {
		throw new Error(`Failed to fetch relationships for loser entity ${loserId}: ${edgesErr.message}`);
	}

	const edges = rawEdges || [];
	for (const edge of edges) {
		const newFrom = edge.from_entity_id === loserId ? winnerId : edge.from_entity_id;
		const newTo = edge.to_entity_id === loserId ? winnerId : edge.to_entity_id;

		// Self-loop: winner pointing to winner
		if (newFrom === newTo) {
			await supabase
				.from("entity_relationships")
				.update({ archived: true, updated_at: nowIso })
				.eq("id", edge.id);
			archivedEdgeIds.push(edge.id);
			continue;
		}

		let newType = edge.relationship_type;
		// Demotion for belongs_to on project/resource (#170)
		if (
			edge.relationship_type === "belongs_to" &&
			edge.from_entity_id === loserId &&
			edge.archived !== true &&
			(winnerRow.entity_type === "project" || winnerRow.entity_type === "resource")
		) {
			const { data: existingBelongsTo } = await supabase
				.from("entity_relationships")
				.select("id")
				.eq("user_id", userId)
				.eq("from_entity_id", winnerId)
				.eq("relationship_type", "belongs_to")
				.neq("archived", true)
				.neq("to_entity_id", newTo)
				.limit(1);

			if (existingBelongsTo && existingBelongsTo.length > 0) {
				demotedEdgeTypes[edge.id] = edge.relationship_type;
				newType = "associated_with";
			}
		}

		// Collision check with existing active edge
		const { data: existingEdge } = await supabase
			.from("entity_relationships")
			.select("id")
			.eq("user_id", userId)
			.eq("from_entity_id", newFrom)
			.eq("to_entity_id", newTo)
			.eq("relationship_type", newType)
			.neq("archived", true)
			.neq("id", edge.id)
			.limit(1);

		if (existingEdge && existingEdge.length > 0) {
			delete demotedEdgeTypes[edge.id];
			await supabase
				.from("entity_relationships")
				.update({ archived: true, updated_at: nowIso })
				.eq("id", edge.id);
			archivedEdgeIds.push(edge.id);
			continue;
		}

		await supabase
			.from("entity_relationships")
			.update({
				from_entity_id: newFrom,
				to_entity_id: newTo,
				relationship_type: newType,
				updated_at: nowIso,
			})
			.eq("id", edge.id);
		movedEdgeIds.push(edge.id);
	}

	// 2. Repoint artifact entity links
	const { data: rawLinks, error: linksErr } = await supabase
		.from("artifact_entity_links")
		.select("*")
		.eq("entity_id", loserId)
		.eq("user_id", userId);

	if (linksErr) {
		throw new Error(`Failed to fetch artifact links for loser entity ${loserId}: ${linksErr.message}`);
	}

	const links = rawLinks || [];
	for (const link of links) {
		const { data: existingLink } = await supabase
			.from("artifact_entity_links")
			.select("id")
			.eq("user_id", userId)
			.eq("artifact_id", link.artifact_id)
			.eq("entity_id", winnerId)
			.eq("link_type", link.link_type)
			.neq("id", link.id)
			.limit(1);

		if (existingLink && existingLink.length > 0) {
			await supabase.from("artifact_entity_links").delete().eq("id", link.id);
			linksDeleted.push(link.id);
			continue;
		}

		await supabase
			.from("artifact_entity_links")
			.update({ entity_id: winnerId })
			.eq("id", link.id);
		linksMoved.push(link.id);
	}

	// 3. Update winner entity
	const { error: winnerUpdateErr } = await supabase
		.from("entities")
		.update({
			properties: finalWinnerProps,
			aliases: winnerAliases,
			updated_at: nowIso,
		})
		.eq("id", winnerId)
		.eq("user_id", userId);

	if (winnerUpdateErr) {
		throw new Error(`Failed to update winner entity ${winnerId}: ${winnerUpdateErr.message}`);
	}

	// 4. Construct _merge record
	const opId = crypto.randomUUID();
	const mergeOp: EntityMergeRecord = {
		op_id: opId,
		merged_at: nowIso,
		winner_id: winnerId,
		moved_edge_ids: movedEdgeIds,
		archived_edge_ids: archivedEdgeIds,
		aliases_added: aliasesAdded,
		properties_carried: propertiesCarried,
		links_moved: linksMoved,
		links_deleted: linksDeleted,
		...(Object.keys(propertiesSkipped).length > 0 ? { properties_skipped: propertiesSkipped } : {}),
		...(Object.keys(demotedEdgeTypes).length > 0 ? { demoted_edge_types: demotedEdgeTypes } : {}),
	};

	// 5. Update loser entity with tombstone
	const loserProps = (loserRow.properties || {}) as Record<string, unknown>;
	const { error: loserUpdateErr } = await supabase
		.from("entities")
		.update({
			archived: true,
			archived_at: nowIso,
			properties: {
				...loserProps,
				merged_into: winnerId,
				merged_at: nowIso,
				archived_reason: "merged_duplicate",
				_merge: mergeOp,
			},
			updated_at: nowIso,
		})
		.eq("id", loserId)
		.eq("user_id", userId);

	if (loserUpdateErr) {
		throw new Error(`Failed to tombstone loser entity ${loserId}: ${loserUpdateErr.message}`);
	}

	// 6. Update system decision if provided
	if (decisionId) {
		const { error: decisionUpdateErr } = await supabase
			.from("system_decisions")
			.update({
				status: "approved",
				resolved_by: userId,
				resolved_at: nowIso,
				resolution_notes: resolutionNotes,
				decision_payload: {
					...(payload || {}),
					winnerEntityId: winnerId,
					loserEntityId: loserId,
					mergedAt: nowIso,
					survivorOverridden,
					mergeOpId: opId,
				},
			})
			.eq("id", decisionId)
			.eq("user_id", userId);

		if (decisionUpdateErr) {
			process.stderr.write(
				`[executeClientSideEntityMerge] Failed to update system_decision ${decisionId}: ${decisionUpdateErr.message}\n`,
			);
		}
	}

	return mergeOp;
}

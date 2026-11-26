import type { GenericSupabaseClient } from "../../actions/github/issueCreate.js";
import {
	isGraphEdgeValidAt,
	type GetGraphEntitiesInput,
	type GraphEdgePort,
	type GraphEdgeRecord,
	type GraphEntityNode,
	type ListArtifactHopsInput,
	type ListGraphEdgesInput,
} from "../../ports/graph.js";

export { isGraphEdgeValidAt };

export function createSupabaseGraphEdgeAdapter(supabase: GenericSupabaseClient): GraphEdgePort {
	return {
		async listEdges(input: ListGraphEdgesInput): Promise<GraphEdgeRecord[]> {
			if (input.frontier.length === 0) return [];
			const col = input.direction === "out" ? "from_entity_id" : "to_entity_id";
			let query = supabase
				.from("entity_relationships")
				.select("from_entity_id, to_entity_id, relationship_type, valid_from, valid_to, archived")
				.eq("user_id", input.userId)
				.in(col, input.frontier);
			if (!input.includeArchived) {
				query = query.eq("archived", false);
			}
			if (input.edgeTypes && input.edgeTypes.length > 0) {
				query = query.in("relationship_type", input.edgeTypes);
			}
			const { data, error } = await query;
			if (error) {
				throw new Error(`Edge query failed: ${error.message}`);
			}
			const rows = (data ?? []) as GraphEdgeRecord[];
			if (!input.asOf) return rows;
			return rows.filter((r) => isGraphEdgeValidAt(r.valid_from, r.valid_to, input.asOf!));
		},

		async listArtifactHops(input: ListArtifactHopsInput): Promise<GraphEdgeRecord[]> {
			if (input.frontier.length === 0) return [];
			const { data: startLinks, error: startErr } = await supabase
				.from("artifact_entity_links")
				.select("entity_id, artifact_id")
				.eq("user_id", input.userId)
				.in("entity_id", input.frontier);
			if (startErr) {
				throw new Error(`Artifact link query failed: ${startErr.message}`);
			}
			const startRows = (startLinks ?? []) as Array<{ entity_id: string; artifact_id: string }>;
			const artifactIds = Array.from(new Set(startRows.map((r) => r.artifact_id)));
			if (artifactIds.length === 0) return [];

			const { data: peerLinks, error: peerErr } = await supabase
				.from("artifact_entity_links")
				.select("entity_id, artifact_id")
				.eq("user_id", input.userId)
				.in("artifact_id", artifactIds);
			if (peerErr) {
				throw new Error(`Peer artifact link query failed: ${peerErr.message}`);
			}
			const peerRows = (peerLinks ?? []) as Array<{ entity_id: string; artifact_id: string }>;
			const byArtifact = new Map<string, string[]>();
			for (const row of peerRows) {
				const list = byArtifact.get(row.artifact_id) ?? [];
				list.push(row.entity_id);
				byArtifact.set(row.artifact_id, list);
			}

			const edges: GraphEdgeRecord[] = [];
			const seen = new Set<string>();
			for (const s of startRows) {
				const peers = byArtifact.get(s.artifact_id) ?? [];
				for (const peerId of peers) {
					if (peerId === s.entity_id) continue;
					const key = `${s.entity_id}|${peerId}`;
					if (seen.has(key)) continue;
					seen.add(key);
					edges.push({
						from_entity_id: s.entity_id,
						to_entity_id: peerId,
						relationship_type: "co_mentioned",
					});
				}
			}
			return edges;
		},

		async getEntities(input: GetGraphEntitiesInput): Promise<GraphEntityNode[]> {
			if (input.ids.length === 0) return [];
			const { data, error } = await supabase
				.from("entities")
				.select("id, title, entity_type")
				.eq("user_id", input.userId)
				.in("id", input.ids);
			if (error) {
				throw new Error(`Entity lookup failed: ${error.message}`);
			}
			return (data ?? []) as GraphEntityNode[];
		},
	};
}

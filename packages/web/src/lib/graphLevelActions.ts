import {
  graphNodeLevelInputSchema,
  type GraphNodeLevelInput,
  type GraphNodeLevelOutput,
} from "@ahkms/core";
import { type ClientActionDefinition, executeActionClient } from "./actionClient.js";

export const graphNodeLevelSchema = graphNodeLevelInputSchema;
export type { GraphNodeLevelInput, GraphNodeLevelOutput };

/**
 * Client Action Definition for shifting node zoom level in Centralised Action Registry (CAR).
 * Promotes (moves up towards level 1 anchor) or demotes (moves down towards level 14 detail).
 * In production, mutations route through CAR on the server (/api/actions/graph_node_level).
 * Client action has no local run handler (ADR-101 #1449).
 */
export const graphNodeLevelActionClient: ClientActionDefinition<
  GraphNodeLevelInput,
  GraphNodeLevelOutput
> = {
  id: "graph_node_level",
  name: "graph_node_level",
  description:
    "Move an entity node up or down in hierarchy zoom level (Level 1..14) or set its discrete zoom level in the ahOS knowledge graph.",
  schema: graphNodeLevelSchema,
};

export async function executeGraphNodeLevel(
  input: GraphNodeLevelInput,
): Promise<GraphNodeLevelOutput> {
  return await executeActionClient(graphNodeLevelActionClient, input);
}


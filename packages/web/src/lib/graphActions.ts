import {
  graphFilterInputSchema,
  type GraphFilterInput,
  type GraphFilterOutput,
} from "@ahkms/core";
import { type ClientActionDefinition, executeActionClient } from "./actionClient.js";

export { graphFilterInputSchema, type GraphFilterInput, type GraphFilterOutput };

export type GraphFilterListener = (input: GraphFilterInput) => void;
const listeners = new Set<GraphFilterListener>();

/**
 * Register a listener to receive graph filter events from the Action Registry.
 */
export function registerGraphFilterListener(listener: GraphFilterListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function runGraphFilter(input: GraphFilterInput): Promise<GraphFilterOutput> {
  if (listeners.size === 0) {
    throw new Error("No active graph view is open to apply graph filter.");
  }
  for (const listener of listeners) {
    listener(input);
  }
  const typeDescription = input.entity_types?.join(", ") || input.entity_type;
  return {
    success: true,
    filter: input,
    message: input.reset
      ? "Graph filters reset to default view"
      : `Applied graph filter: ${input.query || typeDescription || "custom"}`,
  };
}

/**
 * Client Action Definition for Graph Filtering via Centralised Action Registry.
 * Allows conversational agents and UI components to filter the knowledge graph.
 */
export const graphFilterActionClient: ClientActionDefinition<
  GraphFilterInput,
  GraphFilterOutput
> = {
  id: "graph_filter",
  name: "graph_filter",
  description:
    "Filter the interactive knowledge graph view by search query, entity_types (multi-select), hierarchy_level grouping, or reset filters.",
  schema: graphFilterInputSchema,
  run: runGraphFilter,
};

export async function executeGraphFilter(input: GraphFilterInput) {
  return await executeActionClient(graphFilterActionClient, input);
}


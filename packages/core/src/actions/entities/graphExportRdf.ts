import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { renderTurtle } from "../../domain/rdf/exportRdf.js";
import type { VocabularyReadPort } from "../../ports/vocabulary.js";

export const graphExportRdfInput = z.object({});

export type GraphExportRdfInput = z.infer<typeof graphExportRdfInput>;

export const graphExportRdfOutput = z.object({
	turtle: z.string(),
});

export type GraphExportRdfOutput = z.infer<typeof graphExportRdfOutput>;

/**
 * Create the `graph_export_rdf` action over `VocabularyReadPort` (#1495, ADR-105).
 */
export function createGraphExportRdfAction(
	port: VocabularyReadPort,
): ActionDefinition<typeof graphExportRdfInput, GraphExportRdfOutput> {
	return defineAction({
		id: "graph_export_rdf",
		name: "graph_export_rdf",
		description:
			"Export the knowledge graph's VOCABULARY layer as valid Turtle: the namespace prefixes plus each vocabulary term as a CURIE-compacted triple block. Registry IRIs only — there is no triple store, and it does NOT export instance data such as people, organisations or relationships. Full notes: docs/guides/tools/graph_export_rdf.md",
		domain: "kg",
		schema: graphExportRdfInput,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		formatMcp: (out: GraphExportRdfOutput) => out.turtle,
		run: async (_input: GraphExportRdfInput, ctx) => {
			if (!ctx.userId) {
				throw new Error("graph_export_rdf requires an authenticated userId in ActionContext.");
			}
			const { namespaces, terms } = await port.fetchRdfExportState(ctx.userId);
			const turtle = renderTurtle({ namespaces, terms });
			return { turtle };
		},
	});
}

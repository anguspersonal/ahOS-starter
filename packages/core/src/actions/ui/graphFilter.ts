import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	graphFilterInputSchema,
	type GraphFilterOutput,
} from "../../domain/uiActions.js";

const CLIENT_LOCAL_EXPOSE = {
	mcp: false,
	http: false,
	ui_agent: true,
	worker: false,
	reason: "client_local" as const,
	note: "Runs in the browser against local UI state; bound via bindLocalHandler in web (ADR-105, #1557).",
};

export function createGraphFilterAction(): ActionDefinition<
	typeof graphFilterInputSchema,
	GraphFilterOutput
> {
	return defineAction<typeof graphFilterInputSchema, GraphFilterOutput>({
		id: "graph_filter",
		name: "graph_filter",
		description:
			"Filter the interactive knowledge graph view by search query, entity_types (multi-select), hierarchy_level grouping, or reset filters.",
		domain: "kg",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		expose: CLIENT_LOCAL_EXPOSE,
		schema: graphFilterInputSchema,
		run: async () => {
			throw new Error("client_local action runs in the browser");
		},
	});
}

export const graphFilterAction = createGraphFilterAction();

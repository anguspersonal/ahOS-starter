import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { viewScreenInputSchema } from "../../domain/uiActions.js";

const CLIENT_LOCAL_EXPOSE = {
	mcp: false,
	http: false,
	ui_agent: true,
	worker: false,
	reason: "client_local" as const,
	note: "Runs in the browser against local UI state; bound via bindLocalHandler in web (ADR-105, #1557).",
};

export function createViewScreenAction(): ActionDefinition<
	typeof viewScreenInputSchema,
	Record<string, unknown>
> {
	return defineAction<typeof viewScreenInputSchema, Record<string, unknown>>({
		id: "view_screen",
		name: "view_screen",
		description:
			"Inspect the user's current screen, active workspace tab, graph selection, and filters. Call this tool before acting on 'this' or 'the selected' entity or edge to understand what the user is looking at. Set include_record to true to fetch the full database record of the selected entity.",
		domain: "kg",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		expose: CLIENT_LOCAL_EXPOSE,
		schema: viewScreenInputSchema,
		run: async () => {
			throw new Error("client_local action runs in the browser");
		},
	});
}

export const viewScreenAction = createViewScreenAction();

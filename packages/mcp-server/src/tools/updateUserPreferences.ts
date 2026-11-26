import {
	configPreferencesUpdateInput,
	type ConfigPreferencesUpdateInput,
} from "@ahkms/core";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { serverRegistry } from "../actions/serverRegistry.js";

export const updateUserPreferencesInput = configPreferencesUpdateInput;

export async function updateUserPreferencesHandler(
	args: ConfigPreferencesUpdateInput,
	extra?: unknown,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
	const action = serverRegistry().get("config_preferences_update");
	if (!action) {
		throw new Error('Action "config_preferences_update" is not registered in serverRegistry()');
	}
	return toMcpTool(action).handler(
		(args ?? {}) as Record<string, unknown>,
		extra as Parameters<ReturnType<typeof toMcpTool>["handler"]>[1],
	);
}

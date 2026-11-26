import { AsyncLocalStorage } from "node:async_hooks";
import {
	setActionScope,
	type ActionContext,
	type ActionScope,
} from "@ahkms/core";

/**
 * Installs a Node AsyncLocalStorage-backed ActionScope as the active action scope
 * so each MCP request, legacy tool call, and `/api/actions` request forms a single
 * trace across nested action invocations (ADR-104, ADR-105 #1466, #1562).
 */
export function configureActionScope(): ActionScope {
	const storage = new AsyncLocalStorage<ActionContext>();
	const scope: ActionScope = {
		current: () => storage.getStore(),
		run: (ctx, fn) => storage.run(ctx, fn),
	};
	setActionScope(scope);
	return scope;
}

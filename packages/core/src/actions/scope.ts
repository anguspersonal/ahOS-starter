import type { ActionContext } from "./types.js";

/**
 * Isomorphic action execution scope port (ADR-104 §1, ADR-105 L2, #1561).
 * Front doors (e.g. Node AsyncLocalStorage) install an active scope via `setActionScope`;
 * the default is a pure no-op so browser/isomorphic callers require zero Node built-ins.
 */
export interface ActionScope {
	current(): ActionContext | undefined;
	run<T>(ctx: ActionContext, fn: () => T): T;
}

export const noopActionScope: ActionScope = {
	current: () => undefined,
	run: (_ctx, fn) => fn(),
};

let activeActionScope: ActionScope = noopActionScope;

export function setActionScope(scope: ActionScope): void {
	activeActionScope = scope;
}

export function getActionScope(): ActionScope {
	return activeActionScope;
}

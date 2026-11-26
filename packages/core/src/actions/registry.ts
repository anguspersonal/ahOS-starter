import type { ActionDefinition, ActionDomain } from "./types.js";
import { executeAction, type ExecuteActionOptions } from "./adapters/direct.js";

export interface ActionRegistryFilter {
	domain?: ActionDomain;
	readOnly?: boolean;
}

/**
 * Centralised Action Registry ("CAR") catalog.
 * Manages capability definitions, provides domain filtering,
 * and compiles actions for MCP, CLI, Edge, and Agent surfaces.
 */
export class ActionRegistry {
	private actions = new Map<string, ActionDefinition<any, any>>();

	/**
	 * Register an ActionDefinition in the registry.
	 * Throws if the action ID is empty or already registered.
	 */
	register(action: ActionDefinition<any, any>): void {
		if (!action || typeof action.id !== "string" || action.id.trim().length === 0) {
			throw new Error("Action must have a valid non-empty id");
		}
		if (this.actions.has(action.id)) {
			throw new Error(`Action "${action.id}" is already registered in CAR`);
		}
		this.actions.set(action.id, action);
	}

	/**
	 * Retrieve an action by ID.
	 */
	get(id: string): ActionDefinition<any, any> | undefined {
		return this.actions.get(id);
	}

	/**
	 * Check if an action ID exists.
	 */
	has(id: string): boolean {
		return this.actions.has(id);
	}

	/**
	 * List actions with optional domain or readOnly filtering.
	 */
	list(filter?: ActionRegistryFilter): ActionDefinition<any, any>[] {
		let result = Array.from(this.actions.values());
		if (filter?.domain) {
			result = result.filter((a) => a.domain === filter.domain);
		}
		if (filter?.readOnly !== undefined) {
			result = result.filter((a) => a.annotations.readOnlyHint === filter.readOnly);
		}
		return result;
	}

	/**
	 * Total count of registered actions.
	 */
	get size(): number {
		return this.actions.size;
	}

	/**
	 * Execute a registered action directly by ID.
	 */
	async execute<TInput = unknown, TOutput = unknown>(
		id: string,
		input: TInput,
		options?: ExecuteActionOptions,
	): Promise<TOutput> {
		const action = this.get(id);
		if (!action) {
			throw new Error(`Action "${id}" is not registered in CAR`);
		}
		return (await executeAction(action, input, options)) as TOutput;
	}

	/**
	 * Clear all registered actions (primarily for testing).
	 */
	clear(): void {
		this.actions.clear();
	}
}

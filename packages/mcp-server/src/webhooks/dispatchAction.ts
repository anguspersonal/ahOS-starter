import type { ActionDefinition } from "@ahkms/core";
import { executeAction } from "../actions/adapters/direct.js";
import { getCurrentUserId } from "../identity.js";
import { serverRegistry } from "../actions/serverRegistry.js";

/**
 * Dispatch a webhook-originated unit of work through its registered action in
 * `serverRegistry()` (ADR-100, ADR-104 L1, ADR-105 L4) rather than calling the
 * domain function directly, so every verified webhook delivery gets schema
 * validation, `ActionContext` tagged `caller: "http"` with `metadata: { route }`,
 * and uniform `[audit:action]` ledgering.
 *
 * Identity: `getCurrentUserId()` is the single owner (`KMS_USER_ID`, a required
 * boot var of this same Railway process), passed explicitly so the execution
 * never depends on ambient state.
 */
export function dispatchAction<TInput = Record<string, never>, TOutput = unknown>(
	id: string,
	route: string,
): (input?: TInput) => Promise<TOutput> {
	return async (input) => {
		const action = serverRegistry().get(id) as
			| ActionDefinition<any, TOutput>
			| undefined;
		if (!action) {
			throw new Error(`Webhook action "${id}" is not registered in serverRegistry`);
		}
		return await executeAction(action, (input ?? {}) as TInput, {
			context: {
				caller: "http",
				userId: getCurrentUserId(),
				metadata: { route },
			},
		});
	};
}

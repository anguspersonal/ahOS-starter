import {
	executeAction,
	setDefaultAuditSink,
	stderrAuditSink,
} from "../../actions/adapters/direct.js";
import type { ActionLookup } from "../../actions/approvals.js";
import type { ActionAuditSink, ActionDefinition } from "../../actions/types.js";
import type { Cadence } from "../lock.js";
import type { CadenceDefinition } from "../runner.js";

export interface ActionCadenceOptions<TInput = Record<string, unknown>> {
	name: Cadence;
	intervalMs: number;
	actionId: string;
	registry?: ActionLookup;
	action?: ActionDefinition<any, any>;
	input?: TInput | (() => TInput | Promise<TInput>);
	userId?: string | (() => string | undefined | Promise<string | undefined>);
	connector?: string;
	enabled?: () => boolean;
	shouldRecord?: (counts: Record<string, unknown>) => boolean;
	mapResult?: (result: any) => Record<string, unknown>;
	auditSink?: ActionAuditSink;
}

function resolveCadenceAction(
	actionId: string,
	registry?: ActionLookup,
	directAction?: ActionDefinition<any, any>,
): ActionDefinition<any, any> | undefined {
	if (typeof registry === "function") {
		return registry(actionId);
	}
	if (registry && typeof registry.get === "function") {
		return registry.get(actionId);
	}
	if (directAction && directAction.id === actionId) {
		return directAction;
	}
	return undefined;
}

/**
 * Builds an engine CadenceDefinition whose tick dispatches a single worker-exposed
 * registry action through executeAction with caller "worker" (ADR-101 §2, ADR-105 R5 #1554).
 *
 * Validates at build time that the action exists and has expose.worker = true.
 */
export function actionCadence<TInput = Record<string, unknown>>(
	options: ActionCadenceOptions<TInput>,
): CadenceDefinition {
	const action = resolveCadenceAction(options.actionId, options.registry, options.action);
	if (!action) {
		throw new Error(`Unknown cadence action: ${options.actionId}`);
	}
	if (!action.expose?.worker) {
		throw new Error(`Action ${action.id} is not exposed to worker`);
	}

	return {
		name: options.name,
		intervalMs: options.intervalMs,
		connector: options.connector,
		enabled: options.enabled ?? (() => true),
		shouldRecord: options.shouldRecord,
		run: async () => {
			const inputValue =
				typeof options.input === "function"
					? await (options.input as () => TInput | Promise<TInput>)()
					: (options.input ?? {});
			const userId =
				typeof options.userId === "function" ? await options.userId() : options.userId;

			if (options.auditSink) {
				setDefaultAuditSink(options.auditSink);
			}
			try {
				const result = await executeAction(action, inputValue, {
					context: {
						caller: "worker",
						...(userId ? { userId } : {}),
					},
					auditSink: options.auditSink,
				});
				if (options.mapResult) {
					return options.mapResult(result);
				}
				return (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
			} finally {
				if (options.auditSink) {
					setDefaultAuditSink(stderrAuditSink);
				}
			}
		},
	};
}

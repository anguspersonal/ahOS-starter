import type { CadenceDefinition } from "../runner.js";
import type { ActionLookup } from "../../actions/approvals.js";
import { createEntityDeriveSweepAction } from "../../actions/engine/deriveSweep.js";
import type { EntityDerivePorts } from "../../actions/domain/derivePorts.js";
import type { ActionAuditSink } from "../../actions/types.js";
import { actionCadence } from "./actionCadence.js";

export { actionCadence, type ActionCadenceOptions } from "./actionCadence.js";

export interface DeriveCadenceOptions {
	ports?: EntityDerivePorts;
	registry?: ActionLookup;
	/**
	 * Resolves the owner user ids to derive for. The scheduled cadence never runs
	 * without an explicit owner (#1306 C1); an empty list is an error, not a no-op.
	 */
	resolveUserIds: () => Promise<string[]>;
	intervalMs?: number;
	/** Per-user, per-tick artifact budget. */
	batchLimit?: number;
	enabled?: () => boolean;
	auditSink?: ActionAuditSink;
}

/**
 * Creates the entity derivation background cadence definition (ADR-101 #1321, ADR-105 #1554).
 * Single-flight via scheduler_locks, run history via scheduler_runs.
 * Dispatches `entity_derive_sweep` through `actionCadence`.
 */
export function createDeriveCadence(options: DeriveCadenceOptions): CadenceDefinition {
	const batchLimit = options.batchLimit ?? 5;
	const action = options.ports
		? createEntityDeriveSweepAction(options.ports, {
				resolveUserIds: options.resolveUserIds,
				auditSink: options.auditSink,
			})
		: undefined;

	return actionCadence({
		name: "derive",
		intervalMs: options.intervalMs ?? 60 * 60 * 1000,
		actionId: "entity_derive_sweep",
		registry: options.registry,
		action,
		input: async () => ({
			user_ids: await options.resolveUserIds(),
			limit: batchLimit,
			force: false,
		}),
		enabled: options.enabled ?? (() => true),
	});
}


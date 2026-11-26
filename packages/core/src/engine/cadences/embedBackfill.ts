import type { CadenceDefinition } from "../runner.js";
import type { ActionLookup } from "../../actions/approvals.js";
import {
	createArtifactEmbedBackfillAction,
	type ArtifactEmbedBackfillInput,
	type ArtifactEmbedBackfillPorts,
} from "../../actions/artifacts/embedBackfill.js";
import type { ActionAuditSink } from "../../actions/types.js";
import { actionCadence } from "./actionCadence.js";

export const DEFAULT_EMBED_BACKFILL_INTERVAL_MS = 15 * 60 * 1000;

export interface EmbedBackfillCadenceOptions {
	ports?: ArtifactEmbedBackfillPorts;
	registry?: ActionLookup;
	intervalMs?: number;
	batchSize?: number;
	maxBatches?: number;
	dryRun?: boolean;
	userId?: string | (() => string | undefined | Promise<string | undefined>);
	enabled?: () => boolean;
	auditSink?: ActionAuditSink;
}

/**
 * Engine cadence that dispatches `artifact_embed_backfill` through `actionCadence`
 * with caller `"worker"` (ADR-105 section 4, #1554, #1617).
 */
export function createEmbedBackfillCadence(
	options: EmbedBackfillCadenceOptions,
): CadenceDefinition {
	const action = options.ports
		? createArtifactEmbedBackfillAction(options.ports)
		: undefined;

	const input: ArtifactEmbedBackfillInput = {
		...(options.batchSize !== undefined ? { batch_size: options.batchSize } : {}),
		...(options.maxBatches !== undefined ? { max_batches: options.maxBatches } : {}),
		...(options.dryRun !== undefined ? { dry_run: options.dryRun } : {}),
	};

	return actionCadence({
		name: "embed_backfill",
		intervalMs: options.intervalMs ?? DEFAULT_EMBED_BACKFILL_INTERVAL_MS,
		actionId: "artifact_embed_backfill",
		registry: options.registry,
		action,
		input,
		userId: options.userId,
		enabled: options.enabled ?? (() => true),
		auditSink: options.auditSink,
	});
}

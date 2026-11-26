import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import { defineAction } from "../defineAction.js";
import { createEntityDeriveAction } from "../definitions/entityDerive.js";
import {
	isCandidateForDerivation,
	type CandidateArtifact,
} from "../domain/derive.js";
import type { EntityDerivePorts } from "../domain/derivePorts.js";
import type { ActionAuditSink } from "../types.js";

const MAX_CANDIDATE_PAGES = 10;
const CANDIDATE_PAGE_SIZE = 50;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const entityDeriveSweepInputSchema = z.object({
	user_ids: z
		.array(z.string())
		.optional()
		.describe("Owner user IDs to sweep; defaults to context.userId"),
	limit: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.default(5)
		.describe("Per-user candidate artifact batch limit"),
	batch_limit: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe("Optional alias for per-user candidate artifact batch limit"),
	force: z
		.boolean()
		.optional()
		.default(false)
		.describe("Re-derive even if already completed"),
});

export type EntityDeriveSweepInput = z.infer<typeof entityDeriveSweepInputSchema>;

export interface EntityDeriveSweepOutput {
	users: number;
	processed: number;
	entities_created: number;
	entities_linked: number;
	relationships_created: number;
	remaining_underived: number;
	errors: number;
}

export interface EntityDeriveSweepOptions {
	resolveUserIds?: () => Promise<string[]>;
	auditSink?: ActionAuditSink;
}

async function pickSweepCandidates(
	ports: EntityDerivePorts,
	userId: string,
	limit: number,
	force: boolean,
): Promise<CandidateArtifact[]> {
	const now = Date.now();
	const selected: CandidateArtifact[] = [];
	for (let page = 0; page < MAX_CANDIDATE_PAGES && selected.length < limit; page++) {
		const rows = await ports.fetchCandidatePage({
			userId,
			offset: page * CANDIDATE_PAGE_SIZE,
			pageSize: CANDIDATE_PAGE_SIZE,
		});
		for (const row of rows) {
			if (isCandidateForDerivation(row, force, now)) selected.push(row);
			if (selected.length >= limit) break;
		}
		if (rows.length < CANDIDATE_PAGE_SIZE) break;
	}
	return selected;
}

/**
 * Builds the worker-only `entity_derive_sweep` action that selects candidate
 * artifacts per owner and dispatches `entity_derive` per artifact as nested calls
 * (ADR-101 §2, ADR-105 R5 #1554).
 */
export function createEntityDeriveSweepAction(
	ports: EntityDerivePorts,
	options?: EntityDeriveSweepOptions,
) {
	return defineAction({
		id: "entity_derive_sweep",
		domain: "kg",
		description:
			"Selects candidate underived artifacts per owner and runs entity_derive for each artifact on the engine cadence.",
		schema: entityDeriveSweepInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		expose: {
			mcp: false,
			http: false,
			ui_agent: false,
			worker: true,
			cli: false,
			a2a: false,
			reason: "app_internal",
			note: "Scheduled engine cadence action that sweeps candidate artifacts via entity_derive (ADR-101 §2, ADR-105 R5)",
		},
		async run(input, context): Promise<EntityDeriveSweepOutput> {
			const rawUserIds: string[] =
				input.user_ids !== undefined
					? input.user_ids
					: options?.resolveUserIds
						? await options.resolveUserIds()
						: context.userId
							? [context.userId]
							: [];
			const userIds: string[] = [...new Set(rawUserIds.filter(Boolean))];
			if (userIds.length === 0) {
				throw new Error("derive cadence has no owner user id configured (set KMS_USER_ID)");
			}

			const batchLimit = Math.min(Math.max(input.batch_limit ?? input.limit ?? 5, 1), 20);
			const force = input.force ?? false;

			const totals: EntityDeriveSweepOutput = {
				users: userIds.length,
				processed: 0,
				entities_created: 0,
				entities_linked: 0,
				relationships_created: 0,
				remaining_underived: 0,
				errors: 0,
			};

			for (const userId of userIds) {
				try {
					let candidates: CandidateArtifact[];
					try {
						candidates = await pickSweepCandidates(ports, userId, batchLimit, force);
					} catch (pickErr) {
						await executeAction(
							createEntityDeriveAction({
								...ports,
								fetchCandidatePage: async () => {
									throw pickErr;
								},
							}),
							{ limit: 1, force },
							{
								context: { userId, caller: "worker" },
								auditSink: options?.auditSink,
							},
						);
						continue;
					}

					for (const artifact of candidates) {
						const isUuid = UUID_RE.test(artifact.id);
						const singleArtifactPorts: EntityDerivePorts = {
							...ports,
							fetchCandidatePage: async () => [artifact],
							fetchArtifactsByIds: async (u, ids) => {
								const rows = await ports.fetchArtifactsByIds(u, ids);
								return rows.length > 0 ? rows : [artifact];
							},
							countUnderived: async () => 0,
						};
						const deriveInput = isUuid
							? { artifact_id: artifact.id, limit: 1, force }
							: { limit: 1, force };
						const result = await executeAction(
							createEntityDeriveAction(singleArtifactPorts),
							deriveInput,
							{
								context: { userId, caller: "worker" },
								auditSink: options?.auditSink,
							},
						);
						totals.processed += result.processed;
						totals.entities_created += result.entities_created;
						totals.entities_linked += result.entities_linked;
						totals.relationships_created += result.relationships_created;
						totals.errors += result.failed ?? 0;
					}

					try {
						const remaining = await ports.countUnderived(userId);
						totals.remaining_underived += remaining ?? 0;
					} catch {
						// Ignore countUnderived error just as entity_derive does
					}
				} catch (err) {
					totals.errors++;
					console.error(`[derive] run failed for user ${userId}:`, err);
				}
			}

			return totals;
		},
	});
}

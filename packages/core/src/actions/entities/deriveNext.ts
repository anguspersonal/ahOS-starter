import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { MAX_DERIVE_ARTIFACT_IDS, type EntityDeriveInput } from "../domain/derive.js";
import type { JobQueuePort } from "../../ports/jobQueue.js";
import type { ActionDefinition } from "../types.js";

export { MAX_DERIVE_ARTIFACT_IDS };

/** Pending entity_derive jobs one owner may have queued at once. */
export const MAX_PENDING_DERIVE_JOBS = 10;

export const ENTITY_DERIVE_NEXT_DESCRIPTION =
	"Enqueue a background job (system_jobs) that extracts entities and relationships from enriched artifacts " +
	"and links them to the knowledge graph. This tool only enqueues and returns a job id; the engine process " +
	"runs the LLM derivation later. Identical pending jobs are deduplicated and at most 10 may be pending. " +
	"Supports batch draining (limit) and targeting up to 20 artifact ids.";

/** Key-order-independent JSON used to detect identical queued payloads. */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export const deriveEntitiesInput = {
	limit: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe("Maximum candidate artifacts to process in this batch (1-20, default 5)."),
	artifact_id: z
		.string()
		.uuid()
		.optional()
		.describe("Optional specific artifact id to derive entities from."),
	artifact_ids: z
		.array(z.string().uuid())
		.max(MAX_DERIVE_ARTIFACT_IDS)
		.optional()
		.describe("Optional explicit list of artifact ids to derive entities from."),
	force: z
		.boolean()
		.optional()
		.describe("Re-derive even if already derived. Defaults to false."),
	provider: z
		.enum(["gemini", "anthropic"])
		.optional()
		.describe("Optional provider override ('gemini' or 'anthropic')."),
	model: z
		.string()
		.optional()
		.describe("Optional model override."),
} as const;

export const deriveEntitiesSchema = z.object(deriveEntitiesInput);
export const entityDeriveNextInput = deriveEntitiesInput;
export const entityDeriveNextInputSchema = deriveEntitiesSchema;

export type EntityDeriveNextInput = z.infer<typeof deriveEntitiesSchema>;

export interface EntityDeriveNextOutput {
	job_id: string;
	deduplicated: boolean;
	payload: EntityDeriveInput;
	message: string;
}

export function formatEntityDeriveNextMcp(out: EntityDeriveNextOutput): string {
	return out.message;
}

/**
 * Enqueue action for entity derivation (#vision, ADR-101 §4, #1506).
 *
 * Enqueues a `system_jobs` row (`type = 'entity_derive'`) for the background
 * engine runner to process asynchronously, ensuring zero long-running or batch
 * LLM execution on the front door.
 */
export function createEntityDeriveNextAction(
	jobs: JobQueuePort,
): ActionDefinition<typeof deriveEntitiesSchema, EntityDeriveNextOutput> {
	return defineAction({
		id: "entity_derive_next",
		name: "entity_derive_next",
		domain: "kg",
		description: ENTITY_DERIVE_NEXT_DESCRIPTION,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: deriveEntitiesSchema,
		formatMcp: formatEntityDeriveNextMcp,
		async run(args: EntityDeriveNextInput, ctx) {
			const userId = ctx?.userId?.trim();
			if (!userId) {
				throw new Error("entity_derive_next requires an authenticated userId in ActionContext.");
			}

			const payload: EntityDeriveInput = {
				artifact_id: args.artifact_id,
				artifact_ids: args.artifact_ids,
				limit: args.limit ?? 5,
				force: args.force ?? false,
				provider: args.provider,
				model: args.model,
			};

			// Dedupe and cap before inserting: an agent retry must not queue unlimited
			// identical LLM jobs.
			const pending = await jobs
				.listPending(userId, "entity_derive", MAX_PENDING_DERIVE_JOBS + 1)
				.catch((err) => {
					const detail = (err instanceof Error ? err.message : String(err)).replace(
						/^Failed to list pending entity_derive jobs:\s*/,
						"",
					);
					throw new Error(`Failed to check pending entity derivation jobs: ${detail}`);
				});

			const wanted = stableStringify(payload);
			const duplicate = (pending ?? []).find((row) => stableStringify(row.payload) === wanted);
			if (duplicate) {
				const message = `An identical entity derivation job [${duplicate.id}] is already queued; not enqueuing another.`;
				return {
					job_id: duplicate.id,
					deduplicated: true,
					payload,
					message,
				};
			}
			if ((pending ?? []).length >= MAX_PENDING_DERIVE_JOBS) {
				throw new Error(
					`Too many pending entity derivation jobs (${MAX_PENDING_DERIVE_JOBS}); wait for the engine to drain the queue.`,
				);
			}

			const data = await jobs.enqueue(userId, "entity_derive", payload).catch((err) => {
				const detail = (err instanceof Error ? err.message : String(err)).replace(
					/^Failed to enqueue entity_derive job:\s*/,
					"",
				);
				throw new Error(`Failed to enqueue entity derivation job: ${detail}`);
			});

			const targetMsg = args.artifact_id
				? `artifact ${args.artifact_id}`
				: args.artifact_ids && args.artifact_ids.length > 0
					? `${args.artifact_ids.length} artifacts`
					: `batch of candidates (limit ${payload.limit})`;
			const message = `Enqueued entity derivation job [${data.id}] for ${targetMsg}. The background engine runner will process it; this tool does not run derivation itself.`;

			return {
				job_id: data.id,
				deduplicated: false,
				payload,
				message,
			};
		},
	});
}

import { z } from "zod";
import { embedAndStore, type RetryOptions } from "../../domain/embeddings.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	EntityMergeLoserRow,
	EntityMergePort,
	UnmergeExecutionResult,
} from "../../ports/entityMerge.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const ENTITY_UNMERGE_DESCRIPTION =
	"Reverse an entity merge operation by op_id or loser entity_id. Restores the loser entity (archived=false, " +
	"clears merged_into), moves repointed relationship edges and artifact links back, un-archives redundant edges, " +
	"and removes merged-in aliases and carried properties from the winner. Refuses if any affected edge has been edited since the merge.";

export const entityUnmergeInput = {
	op_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"UUID of the merge operation to reverse (from loser's properties._merge.op_id or system_decisions.decision_payload.mergeOpId).",
		),
	entity_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"UUID of the tombstoned loser entity. If provided without op_id, the merge record is read from this entity.",
		),
};

export const entityUnmergeSchema = z.object(entityUnmergeInput);
export type EntityUnmergeInput = z.infer<typeof entityUnmergeSchema>;

export interface EntityUnmergeDeps {
	merge: EntityMergePort;
	embeddings?: EmbeddingPort | null | (() => EmbeddingPort | null);
	embeddingStore?: EmbeddingStorePort;
	ownerId?: string | (() => string);
	retryOptions?: RetryOptions;
}

export function isEntityUnmergeDeps(
	value: EntityMergePort | EntityUnmergeDeps,
): value is EntityUnmergeDeps {
	return "merge" in value && typeof value.merge === "object" && value.merge !== null;
}

const noopEmbeddingStore: EmbeddingStorePort = {
	setEmbedding: async () => {},
};

function writeStderr(line: string): void {
	const stderr = (
		globalThis as { process?: { stderr?: { write?: (s: string) => unknown } } }
	).process?.stderr;
	if (stderr?.write) {
		stderr.write(line);
	}
}

export function formatEntityUnmergeMcp(result: UnmergeExecutionResult): string {
	const movedCount = result.moved_edge_ids?.length ?? 0;
	const typeRestoredCount = result.type_restored_count ?? 0;
	const archivedCount = result.archived_edge_ids?.length ?? 0;
	const linksCount = result.links_moved?.length ?? 0;
	const aliasesCount = result.aliases_removed?.length ?? 0;
	const carriedCount = result.properties_removed?.length ?? 0;

	return (
		`Successfully unmerged entity "${result.loser_title ?? result.loser_id}" from "${result.winner_title ?? result.winner_id}":\n` +
		`- Restored entity: ${result.loser_id} (archived=false, cleared merged_into)\n` +
		`- Edges restored: ${movedCount} moved back (${typeRestoredCount} relationship_type restored), ${archivedCount} un-archived\n` +
		`- Artifact links restored: ${linksCount} moved back\n` +
		`- Winner cleaned: ${result.winner_id} (removed ${aliasesCount} aliases, ${carriedCount} carried properties)\n` +
		`- Re-embedded both entities`
	);
}

export function createEntityUnmergeAction(
	depsOrPort: EntityMergePort | EntityUnmergeDeps,
	embeddingsArg?: EmbeddingPort | null,
	embeddingStoreArg?: EmbeddingStorePort,
): ActionDefinition<typeof entityUnmergeSchema, UnmergeExecutionResult> {
	const deps: EntityUnmergeDeps = isEntityUnmergeDeps(depsOrPort)
		? depsOrPort
		: {
				merge: depsOrPort,
				embeddings: embeddingsArg,
				embeddingStore: embeddingStoreArg,
			};

	return defineAction({
		id: "entity_unmerge",
		name: "entity_unmerge",
		description: ENTITY_UNMERGE_DESCRIPTION,
		domain: "kg",
		schema: entityUnmergeSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (args, ctx) => {
			if (!args.op_id && !args.entity_id) {
				throw new Error("Provide op_id or entity_id to unmerge.");
			}

			const userId =
				ctx.userId ??
				(typeof deps.ownerId === "function" ? deps.ownerId() : deps.ownerId) ??
				"";

			let loser: EntityMergeLoserRow | null = null;
			if (args.entity_id) {
				loser = await deps.merge.findLoserById(args.entity_id, userId);
				if (!loser) {
					throw new Error(`Entity not found: ${args.entity_id}`);
				}
			} else if (args.op_id) {
				loser = await deps.merge.findLoserByOpId(args.op_id, userId);
				if (!loser) {
					throw new Error(`No merged entity found with merge operation ID "${args.op_id}".`);
				}
			}

			const mergeRecord = loser?.properties?._merge;
			if (!mergeRecord || !mergeRecord.winner_id) {
				throw new Error(
					`Entity ${loser!.id} ("${loser!.title ?? "Untitled"}") does not contain a valid _merge record (properties._merge is missing).`,
				);
			}

			if (args.op_id && mergeRecord.op_id && mergeRecord.op_id !== args.op_id) {
				throw new Error(
					`Entity ${loser!.id} merge record op_id ("${mergeRecord.op_id}") does not match requested op_id ("${args.op_id}").`,
				);
			}

			const result = await deps.merge.unmerge(loser!.id, userId);

			const embeddingPort =
				typeof deps.embeddings === "function" ? deps.embeddings() : deps.embeddings;
			const store = deps.embeddingStore ?? noopEmbeddingStore;

			await embedAndStore(
				embeddingPort,
				store,
				"entities",
				result.winner_id,
				{
					title: result.winner_title,
					description: result.winner_description,
					properties: result.winner_properties,
				},
				{
					retryOptions: deps.retryOptions,
					onError: (err) => {
						writeStderr(
							`[entity_unmerge] Failed to re-embed winner ${result.winner_id}: ${String(err)}\n`,
						);
					},
				},
			);

			await embedAndStore(
				embeddingPort,
				store,
				"entities",
				result.loser_id,
				{
					title: result.loser_title,
					description: result.loser_description,
					properties: result.loser_properties,
				},
				{
					retryOptions: deps.retryOptions,
					onError: (err) => {
						writeStderr(
							`[entity_unmerge] Failed to re-embed loser ${result.loser_id}: ${String(err)}\n`,
						);
					},
				},
			);

			return result;
		},
		formatMcp: formatEntityUnmergeMcp,
	});
}

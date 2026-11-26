import type { SupabaseClient } from "@supabase/supabase-js";
import type { EntityMergeRecord } from "../../domain/entityMerge.js";
import type {
	EntityMergeLoserRow,
	EntityMergeParams,
	EntityMergePort,
	UnmergeExecutionResult,
} from "../../ports/entityMerge.js";
import { executeClientSideEntityMerge, isRpcMissingError } from "./entityMergeFallback.js";

export type EntityMergeSupabaseClient = Pick<SupabaseClient, "from" | "rpc">;

export interface SupabaseEntityMergeAdapterOptions {
	client: EntityMergeSupabaseClient;
	ownerId?: string | (() => string);
}

export function createSupabaseEntityMergeAdapter(
	optionsOrClient: SupabaseEntityMergeAdapterOptions | EntityMergeSupabaseClient,
): EntityMergePort {
	const options: SupabaseEntityMergeAdapterOptions =
		"client" in optionsOrClient ? optionsOrClient : { client: optionsOrClient };

	const resolveOwnerId = (override?: string): string => {
		if (override && override.length > 0) return override;
		if (!options.ownerId) return "";
		return typeof options.ownerId === "function" ? options.ownerId() : options.ownerId;
	};

	return {
		async findLoserById(id: string, userId: string): Promise<EntityMergeLoserRow | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entities")
				.select("*")
				.eq("id", id)
				.eq("user_id", activeUserId)
				.maybeSingle();

			if (error) {
				throw new Error(`Failed to fetch entity ${id}: ${error.message}`);
			}
			return (data as EntityMergeLoserRow | null) ?? null;
		},

		async findLoserByOpId(opId: string, userId: string): Promise<EntityMergeLoserRow | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entities")
				.select("*")
				.contains("properties", { _merge: { op_id: opId } })
				.eq("user_id", activeUserId);

			if (error) {
				throw new Error(`Failed to query merge record for op_id ${opId}: ${error.message}`);
			}
			if (!data || data.length === 0) {
				// Fallback filter (some PostgREST configurations reject the nested
				// `.contains()` shape above).
				const { data: fallbackData, error: fallbackError } = await options.client
					.from("entities")
					.select("*")
					.filter("properties->_merge->>op_id", "eq", opId)
					.eq("user_id", activeUserId);

				if (fallbackError) {
					throw new Error(
						`Failed to query merge record for op_id ${opId} (fallback filter): ${fallbackError.message}`,
					);
				}
				if (!fallbackData || fallbackData.length === 0) {
					return null;
				}
				if (fallbackData.length > 1) {
					process.stderr.write(
						`[entity_unmerge] Warning: ${fallbackData.length} entities matched op_id "${opId}" (fallback query); using the first (id=${(fallbackData[0] as EntityMergeLoserRow).id}).\n`,
					);
				}
				return (fallbackData[0] as EntityMergeLoserRow) ?? null;
			}
			if (data.length > 1) {
				process.stderr.write(
					`[entity_unmerge] Warning: ${data.length} entities matched op_id "${opId}"; using the first (id=${(data[0] as EntityMergeLoserRow).id}).\n`,
				);
			}
			return (data[0] as EntityMergeLoserRow) ?? null;
		},

		async unmerge(loserId: string, userId: string): Promise<UnmergeExecutionResult> {
			const activeUserId = resolveOwnerId(userId);
			const { data: rpcResult, error: rpcError } = await options.client.rpc("unmerge_entities", {
				p_loser_id: loserId,
				p_user_id: activeUserId,
			});

			if (rpcError) {
				throw new Error(rpcError.message);
			}
			return rpcResult as UnmergeExecutionResult;
		},

		async merge(params: EntityMergeParams): Promise<EntityMergeRecord | undefined> {
			const activeUserId = resolveOwnerId(params.userId);
			const { data: rpcResult, error: rpcError } = await options.client.rpc("merge_entities", {
				p_winner_id: params.winnerId,
				p_loser_id: params.loserId,
				p_user_id: activeUserId,
				p_winner_properties: params.finalWinnerProps,
				p_winner_aliases: params.winnerAliases,
				p_aliases_added: params.aliasesAdded,
				p_properties_carried: params.propertiesCarried,
				p_properties_skipped: params.propertiesSkipped,
				p_decision_id: params.decisionId,
				p_resolution_notes: params.resolutionNotes,
				p_survivor_overridden: params.survivorOverridden,
				p_decision_status: params.decisionStatus ?? "approved",
				p_resolved_by: params.resolvedBy ?? activeUserId,
			});

			if (rpcError) {
				if (isRpcMissingError(rpcError)) {
					process.stderr.write(
						"[review_resolve] merge_entities RPC missing from schema cache; executing client-side merge fallback.\n",
					);
					return executeClientSideEntityMerge(options.client, {
						...params,
						userId: activeUserId,
						nowIso: params.nowIso ?? new Date().toISOString(),
					});
				}
				throw new Error(`Failed to execute entity merge: ${rpcError.message}`);
			}

			return (rpcResult as { merge_op?: EntityMergeRecord } | null)?.merge_op;
		},
	};
}

import {
	type ClientSideMergeParams,
	executeClientSideEntityMerge as coreExecuteClientSideEntityMerge,
	type EntityMergeFallbackClient,
	isRpcMissingError,
} from "@ahkms/core/adapters";
import type { EntityMergeRecord } from "@ahkms/shared";
import { getCurrentUserId } from "../identity.js";
import { supabase } from "../supabase.js";

export { isRpcMissingError, type ClientSideMergeParams };

export async function executeClientSideEntityMerge(
	params: ClientSideMergeParams,
): Promise<EntityMergeRecord> {
	return coreExecuteClientSideEntityMerge(
		supabase as unknown as EntityMergeFallbackClient,
		params,
		getCurrentUserId,
	);
}

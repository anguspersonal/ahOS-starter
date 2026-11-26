import type { SupabaseClient } from "@supabase/supabase-js";
import {
	getActionApprovalStore,
	setActionApprovalStore,
	withApprovalNotifier,
	type ApprovalInboxStore,
} from "@ahkms/core";
import {
	APPROVAL_ACTION_IDS,
	createApprovalActions as createCoreApprovalActions,
	createInboxActionResolver,
	type ApprovalActions,
	type ApprovedRunner,
	type CallableApprovedRunner,
	type CreateApprovalActionsDeps,
} from "@ahkms/core/actions";
import {
	createSlackApprovalCardNotifier,
	createSupabaseActionApprovalStore,
	resolveSlackOwnerUserId,
} from "@ahkms/core/adapters";
import { env } from "../env.js";
import { getCurrentUserId } from "../identity.js";
import { supabase } from "../supabase.js";
import {
	createLegacyRunner,
	ensureLegacyDispatchers,
	getRegisteredServerRegistry,
} from "./legacyDispatch.js";

function tryGetCurrentUserId(): string | undefined {
	try {
		return getCurrentUserId();
	} catch {
		return undefined;
	}
}

export {
	getActionApprovalStore,
	setActionApprovalStore,
	type ApprovalActions,
	type CreateApprovalActionsDeps,
};

export function resolveLegacyApprovalRunner(
	actionId: string,
): CallableApprovedRunner | undefined {
	if (APPROVAL_ACTION_IDS.has(actionId)) return undefined;
	const wrapped = ensureLegacyDispatchers().get(actionId);
	if (!wrapped) return undefined;
	return createLegacyRunner(wrapped);
}

/**
 * Resolves an approved action id against the action registry first, falling back
 * to the legacy tool dispatcher map (#1422, #1425).
 */
export function inboxActionResolver(
	actionId: string,
): CallableApprovedRunner | undefined {
	const registry = getRegisteredServerRegistry();
	const fromRegistry = registry
		? createInboxActionResolver(registry)(actionId)
		: undefined;
	return fromRegistry ?? resolveLegacyApprovalRunner(actionId);
}

export const resolveApprovalAction = inboxActionResolver;

export function createApprovalActions(
	deps: CreateApprovalActionsDeps,
): ApprovalActions {
	return createCoreApprovalActions({
		getStore: deps.getStore,
		resolve: (actionId: string): ApprovedRunner | undefined =>
			deps.resolve(actionId) ?? resolveLegacyApprovalRunner(actionId),
	});
}

let configuredStore: ApprovalInboxStore | undefined;

/**
 * Installs the process-wide ActionApprovalStore persisting parked outward
 * agent action calls to `system_decisions` (ADR-100 §1, ADR-104 G4, #1417, #1534).
 */
export function configureApprovals(
	client: Pick<SupabaseClient, "from"> = supabase,
): ApprovalInboxStore {
	const baseStore = createSupabaseActionApprovalStore(client);
	const store = env.slackBotToken
		? withApprovalNotifier(
				baseStore,
				createSlackApprovalCardNotifier({
					botToken: () => env.slackBotToken,
					ownerUserId: (userId) =>
						resolveSlackOwnerUserId(client, userId ?? tryGetCurrentUserId()),
					webUrl: () => env.ahosWebUrl,
				}),
			)
		: baseStore;
	configuredStore = store;
	setActionApprovalStore(store);
	return store;
}

/**
 * Returns the approval store installed by `configureApprovals`, or `undefined`.
 */
export function getConfiguredApprovalStore(): ApprovalInboxStore | undefined {
	return getActionApprovalStore() === configuredStore
		? configuredStore
		: undefined;
}

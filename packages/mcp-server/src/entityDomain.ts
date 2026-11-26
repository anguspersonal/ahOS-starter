import {
	fetchPrimaryParentsBatch as fetchPrimaryParentsBatchFromRepo,
	matchesDomainSignals,
	resolveEntityDomain as resolveEntityDomainFromRepo,
	resolveEntityDomainSafely as resolveEntityDomainSafelyFromRepo,
	type EntityDomainResolution as DomainResolution,
	type DomainResolutionContext,
	type ResolvedBy,
} from "@ahkms/core";
import {
	createSupabaseEntityRepository,
	type EntitiesSupabaseClient,
} from "@ahkms/core/adapters";
import { loadDosConfig } from "./dosConfig.js";
import { getCurrentUserId } from "./identity.js";
import { supabase } from "./supabase.js";

export {
	matchesDomainSignals,
	type DomainResolution,
	type DomainResolutionContext,
	type ResolvedBy,
};

function defaultRepo() {
	return createSupabaseEntityRepository({
		client: supabase as unknown as EntitiesSupabaseClient,
		ownerId: getCurrentUserId,
	});
}

export async function fetchPrimaryParentsBatch(ids: string[]): Promise<Map<string, string>> {
	return fetchPrimaryParentsBatchFromRepo(defaultRepo(), ids);
}

export async function resolveEntityDomain(
	entityId: string,
	context?: DomainResolutionContext,
): Promise<DomainResolution> {
	return resolveEntityDomainFromRepo(defaultRepo(), entityId, {
		...context,
		loadDosConfig: context?.loadDosConfig ?? loadDosConfig,
	});
}

export async function resolveEntityDomainSafely(
	entityId: string,
	context?: DomainResolutionContext,
): Promise<DomainResolution> {
	return resolveEntityDomainSafelyFromRepo(defaultRepo(), entityId, {
		...context,
		loadDosConfig: context?.loadDosConfig ?? loadDosConfig,
	});
}

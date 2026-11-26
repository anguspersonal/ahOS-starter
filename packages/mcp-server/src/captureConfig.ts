import {
	applyCaptureRouting,
	capturePreferencesSchema,
	DEFAULT_CAPTURE_PREFERENCES,
	DISCOVER_ROLE_SEED,
	effectiveSurfaceRoleMap,
	isRobotAuthoredArtifact,
	LOCAL_CONNECTORS,
	MACHINE_INGEST_SURFACES,
	METRICS_SURFACES,
	resolveSynthesisRole,
	resolveTrust,
	roleTierFilters,
	type CapturePreferences,
	type CaptureRouting,
	type RoleTierFilter,
	type TagRule,
} from "@ahkms/core";
import {
	createSupabaseConfigRepository,
	type ConfigSupabaseClient,
} from "@ahkms/core/adapters";
import { getCurrentUserId } from "./identity.js";
import { supabase } from "./supabase.js";

export {
	applyCaptureRouting,
	capturePreferencesSchema,
	DEFAULT_CAPTURE_PREFERENCES,
	DISCOVER_ROLE_SEED,
	effectiveSurfaceRoleMap,
	isRobotAuthoredArtifact,
	LOCAL_CONNECTORS,
	MACHINE_INGEST_SURFACES,
	METRICS_SURFACES,
	resolveSynthesisRole,
	resolveTrust,
	roleTierFilters,
	type CapturePreferences,
	type CaptureRouting,
	type RoleTierFilter,
	type TagRule,
};

/**
 * Load the owner's persisted capture context via ConfigRepository (#1599).
 */
export async function loadCapturePreferences(): Promise<CapturePreferences> {
	return createSupabaseConfigRepository({
		client: supabase as unknown as ConfigSupabaseClient,
		ownerId: getCurrentUserId,
	}).loadCapturePreferences();
}

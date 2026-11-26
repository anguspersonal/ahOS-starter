/**
 * Canonical System Instructions (`system-instructions`, #1025 / #1601).
 *
 * Pure builders, types, and staleness checks live in `@ahkms/core` (#1601).
 * This module re-exports them and binds `loadPastedInstructions` /
 * `savePastedInstructions` to the server's Supabase config repository.
 */

import {
	buildCanonicalInstructions,
	CANONICAL_PROSE_PREFIX,
	canonicalize,
	checkInstructionsFreshness,
	cleanToolDescription,
	DEPRECATED_TOOL_ALIAS_NAMES,
	extractSystemInstructionsSync,
	formatAge,
	getCanonicalInstructionsHash,
	getDefaultToolCatalog,
	HOT_TIER_MAX_LINES,
	hashBody,
	LEGACY_CLAUDE_INSTRUCTIONS_CAPABILITY_NAME,
	LEGACY_CLAUDE_INSTRUCTIONS_SYNC_KEY,
	LEGACY_PASTED_INSTRUCTIONS_KEY,
	renderHotTier,
	renderToolTable,
	resolveCanonicalProsePrefix,
	SYSTEM_INSTRUCTIONS_CAPABILITY_NAME,
	SYSTEM_INSTRUCTIONS_SYNC_KEY,
	setDefaultToolCatalogProvider,
	type HotTierRow,
	type InstructionsActionPorts,
	type InstructionsFreshness,
	type PastedInstructionsRecord,
	type RenderedHotTier,
	type ToolSummary,
} from "@ahkms/core";
import {
	type ConfigSupabaseClient,
	createSupabaseConfigRepository,
} from "@ahkms/core/adapters";
import { getCurrentUserId } from "./identity.js";
import { supabase } from "./supabase.js";

export {
	buildCanonicalInstructions,
	CANONICAL_PROSE_PREFIX,
	canonicalize,
	checkInstructionsFreshness,
	cleanToolDescription,
	DEPRECATED_TOOL_ALIAS_NAMES,
	extractSystemInstructionsSync,
	formatAge,
	getCanonicalInstructionsHash,
	getDefaultToolCatalog,
	HOT_TIER_MAX_LINES,
	hashBody,
	LEGACY_CLAUDE_INSTRUCTIONS_CAPABILITY_NAME,
	LEGACY_CLAUDE_INSTRUCTIONS_SYNC_KEY,
	LEGACY_PASTED_INSTRUCTIONS_KEY,
	renderHotTier,
	renderToolTable,
	resolveCanonicalProsePrefix,
	SYSTEM_INSTRUCTIONS_CAPABILITY_NAME,
	SYSTEM_INSTRUCTIONS_SYNC_KEY,
	setDefaultToolCatalogProvider,
	type HotTierRow,
	type InstructionsActionPorts,
	type InstructionsFreshness,
	type PastedInstructionsRecord,
	type RenderedHotTier,
	type ToolSummary,
};

function defaultConfigRepository() {
	return createSupabaseConfigRepository({
		client: supabase as unknown as ConfigSupabaseClient,
		ownerId: getCurrentUserId,
	});
}

/**
 * Load the system instructions sync record from `user_preferences.dos_config`
 * via the shared `ConfigRepository` adapter (#1601).
 */
export async function loadPastedInstructions(): Promise<PastedInstructionsRecord | null> {
	return defaultConfigRepository().loadPastedInstructions();
}

export const loadSystemInstructionsSync = loadPastedInstructions;

/**
 * Save the system instructions sync record into `user_preferences.dos_config`
 * via the shared `ConfigRepository` adapter (#1601).
 */
export async function savePastedInstructions(sha256: string, pasted_at: string): Promise<void> {
	await defaultConfigRepository().savePastedInstructions(sha256, pasted_at);
}

export const saveSystemInstructionsSync = savePastedInstructions;

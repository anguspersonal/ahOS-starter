import {
	attachDosConfigToToneRules,
	audienceSpecs,
	audienceSpecsForDomain,
	audienceSpecSchema,
	dailyLogRoleProperty,
	DEFAULT_DOMAIN,
	DEFAULT_DOS_CONFIG,
	domainConfig,
	DOMAINS,
	dosConfigSchema,
	findAudienceSpec,
	formatDomainSummaryLine,
	loadDosConfig as loadDosConfigFromRepo,
	operatingPrinciples,
	pastedInstructionsSchema,
	pillarNotionOption,
	renderDosConfigSections,
	type ArtefactRegister,
	type AtomType,
	type AudienceSpec,
	type DailyLogProperty,
	type Domain,
	type DomainConfig,
	type DosConfig,
	type DosConfigRowReader,
	type PastedInstructions,
	type Pillar,
	type ToneRulesWithConfig,
} from "@ahkms/core";
import {
	createSupabaseConfigRepository,
	type ConfigSupabaseClient,
} from "@ahkms/core/adapters";
import { getCurrentUserId } from "./identity.js";
import { supabase } from "./supabase.js";

export {
	attachDosConfigToToneRules,
	audienceSpecs,
	audienceSpecsForDomain,
	audienceSpecSchema,
	dailyLogRoleProperty,
	DEFAULT_DOMAIN,
	DEFAULT_DOS_CONFIG,
	domainConfig,
	DOMAINS,
	dosConfigSchema,
	findAudienceSpec,
	formatDomainSummaryLine,
	operatingPrinciples,
	pastedInstructionsSchema,
	pillarNotionOption,
	renderDosConfigSections,
	type ArtefactRegister,
	type AtomType,
	type AudienceSpec,
	type DailyLogProperty,
	type Domain,
	type DomainConfig,
	type DosConfig,
	type DosConfigRowReader,
	type PastedInstructions,
	type Pillar,
	type ToneRulesWithConfig,
};

export async function loadDosConfig(): Promise<DosConfig> {
	return loadDosConfigFromRepo(
		createSupabaseConfigRepository({
			client: supabase as unknown as ConfigSupabaseClient,
			ownerId: getCurrentUserId,
		}),
	);
}

/**
 * The owner's tone rules for the MCP `instructions` handshake (#819, #1987). Total-function
 * by design: any failure path (DB unreachable, malformed blob, thrown client error)
 * degrades to `[]` so server startup and the handshake NEVER block on preferences -
 * a session without tone rules is degraded, not broken. Also attaches the full parsed
 * `dosConfig` as a non-enumerable property so `buildInstructions` can render all
 * `user_preferences.dos_config.*` sections without changing the array return shape.
 */
export async function loadToneRules(): Promise<ToneRulesWithConfig> {
	try {
		const config = await loadDosConfig();
		return attachDosConfigToToneRules(config.tone, config);
	} catch {
		return [];
	}
}

export async function loadOperatingPrinciples(): Promise<string[]> {
	try {
		const config = await loadDosConfig();
		return config.operating_principles;
	} catch {
		return [];
	}
}

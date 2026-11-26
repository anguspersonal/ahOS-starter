import type { z } from "zod";
import {
	createSupabaseConfigRepository,
	type ConfigSupabaseClient,
} from "@ahkms/core/adapters";
import {
	notionConfigSchema,
	type NotionConfig,
	completedAtStampRuleSchema,
	type CompletedAtStampRule,
	notionPersonalConfigSchema,
	type NotionPersonalConfig,
	driveWatchChannelSchema,
	type DriveWatchChannelConfig,
	driveConfigSchema,
	type DriveConfig,
	calendarConfigSchema,
	type CalendarConfig,
	dexConfigSchema,
	type DexConfig,
	brevoConfigSchema,
	type BrevoConfig,
	metaAdsConfigSchema,
	type MetaAdsConfig,
	linkedinConfigSchema,
	type LinkedinConfig,
	githubConfigSchema,
	type GithubConfig,
	bigqueryConfigSchema,
	type BigqueryConfig,
	whatsappConfigSchema,
	type WhatsappConfig,
	type IntegrationConfigResult,
	type IntegrationRouting,
	type IntegrationRow,
	type IntegrationSummary,
} from "@ahkms/core";
import { supabase } from "./supabase.js";
import { getCurrentUserId } from "./identity.js";

export {
	notionConfigSchema,
	type NotionConfig,
	completedAtStampRuleSchema,
	type CompletedAtStampRule,
	notionPersonalConfigSchema,
	type NotionPersonalConfig,
	driveWatchChannelSchema,
	type DriveWatchChannelConfig,
	driveConfigSchema,
	type DriveConfig,
	calendarConfigSchema,
	type CalendarConfig,
	dexConfigSchema,
	type DexConfig,
	brevoConfigSchema,
	type BrevoConfig,
	metaAdsConfigSchema,
	type MetaAdsConfig,
	linkedinConfigSchema,
	type LinkedinConfig,
	githubConfigSchema,
	type GithubConfig,
	bigqueryConfigSchema,
	type BigqueryConfig,
	whatsappConfigSchema,
	type WhatsappConfig,
	type IntegrationConfigResult,
	type IntegrationRouting,
	type IntegrationRow,
	type IntegrationSummary,
};

export const configRepository = createSupabaseConfigRepository({
	client: supabase as unknown as ConfigSupabaseClient,
	ownerId: getCurrentUserId,
});

/**
 * Load a provider's config with detailed status.
 * Distinguishes a DB read error from a genuinely unwired integration (missing row,
 * enabled=false, or schema parse failure).
 */
export async function loadIntegrationConfigDetailed<T>(
	provider: string,
	schema: z.ZodType<T>,
): Promise<IntegrationConfigResult<T>> {
	return configRepository.loadConfigDetailed(provider, schema);
}

/**
 * Load a provider's config for the owner. Returns null when there is no row, the row
 * is disabled, or the config doesn't match the provider's schema - callers surface a
 * clear "not configured" error rather than failing cryptically.
 */
export async function loadIntegrationConfig<T>(
	provider: string,
	schema: z.ZodType<T>,
): Promise<T | null> {
	return configRepository.loadConfig(provider, schema);
}

/**
 * Load a provider's full routing row: `routing` (which upstream to dispatch to, per ADR-032),
 * connection `status`, the non-secret `credential_ref` pointer, and the raw config. Returns
 * null when there is no row. Unlike loadIntegrationConfig this does NOT validate config against
 * a schema — the caller validates the slice it needs. Send-tools switch on `routing`.
 */
export async function loadIntegration(provider: string): Promise<IntegrationRow | null> {
	return configRepository.loadIntegration(provider);
}

/**
 * Every connection row belonging to one provider FAMILY (ADR-060): `posthog` returns
 * the `posthog:work`, `posthog:personal`, ... rows.
 *
 * A prefix query rather than a keyed lookup, because the set is not knowable at compile
 * time — which is the entire reason connections are rows and not a union. Disabled rows
 * are dropped here so callers never have to remember to check.
 */
export async function listIntegrationsByFamily(family: string): Promise<IntegrationRow[]> {
	return configRepository.listByFamily(family);
}

/**
 * Shallow-merge a patch into a provider's config jsonb (non-secret wiring only). Used to
 * cache resolved values (e.g. a LinkedIn author URN) so later calls skip the lookup.
 */
export async function updateIntegrationConfig(
	provider: string,
	patch: Record<string, unknown>,
): Promise<void> {
	return configRepository.updateConfig(provider, patch);
}

/**
 * List the owner's configured integrations WITHOUT echoing any values - only the provider,
 * enabled flag, routing + connection status, and which config keys are set. Safe to print;
 * reveals no ids or secrets.
 */
export async function listIntegrations(): Promise<IntegrationSummary[]> {
	return configRepository.listIntegrations();
}

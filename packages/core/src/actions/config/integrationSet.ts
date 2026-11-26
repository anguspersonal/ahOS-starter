import { z } from "zod";
import { defineAction } from "../defineAction.js";
import {
	notionConfigSchema,
	notionPersonalConfigSchema,
	driveConfigSchema,
	calendarConfigSchema,
	dexConfigSchema,
	brevoConfigSchema,
	metaAdsConfigSchema,
	linkedinConfigSchema,
	githubConfigSchema,
	whatsappConfigSchema,
	redactIntegrationConfig,
} from "../../domain/integrations.js";
import { postHogConnectionConfigSchema } from "../../domain/posthog/contract.js";
import type { ConfigRepository } from "../../ports/config.js";

const knownConfigSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
	notion_work: notionConfigSchema,
	notion_personal: notionPersonalConfigSchema,
	google_drive: driveConfigSchema,
	google_calendar: calendarConfigSchema,
	dex: dexConfigSchema,
	brevo: brevoConfigSchema,
	meta_ads: metaAdsConfigSchema,
	linkedin: linkedinConfigSchema,
	github: githubConfigSchema,
	whatsapp: whatsappConfigSchema,
};

const knownFamilyConfigSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
	posthog: postHogConnectionConfigSchema,
};

function resolveConfigSchema(
	provider: string,
): z.ZodType<Record<string, unknown>> | undefined {
	const exact = knownConfigSchemas[provider];
	if (exact) return exact;
	const idx = provider.indexOf(":");
	return idx === -1 ? undefined : knownFamilyConfigSchemas[provider.slice(0, idx)];
}

const genericConfigSchema = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const integrationSetInput = {
	provider: z
		.string()
		.min(1)
		.describe(
			"Integration provider key, e.g. 'notion_work', 'notion_personal', 'google_drive', 'google_calendar', 'dex', 'brevo', 'meta_ads', 'linkedin', 'github'. Providers with a known schema are validated on write; unknown providers accept a generic flat config.",
		),
	config: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Non-secret config patch (database ids, page ids, workspace names, etc.). MERGED into the existing config — keys you don't mention are left untouched. Do NOT put tokens/secrets here; they belong in env vars (e.g. NOTION_WORK_ACCESS_TOKEN) and are never read from or written to this column.",
		),
	enabled: z
		.boolean()
		.optional()
		.describe("Toggle the integration on/off. Omit to leave unchanged."),
	merge_arrays: z
		.boolean()
		.optional()
		.describe(
			"When true, array values in `config` (e.g. github `read_repos`, `issue_repos`, `pr_repos`) are appended to and deduplicated against existing array values instead of replacing them.",
		),
} as const;

export const integrationSetSchema = z.object(integrationSetInput);

export type IntegrationSetInput = z.infer<typeof integrationSetSchema>;

export interface IntegrationSetOutput {
	status: "created" | "updated" | "noop";
	provider: string;
	enabled: boolean;
	config_keys: string[];
	config?: Record<string, unknown>;
}

function mergeConfigValues(
	existingConfig: Record<string, unknown>,
	patch: Record<string, unknown>,
	mergeArrays: boolean,
): Record<string, unknown> {
	if (!mergeArrays) {
		return { ...existingConfig, ...patch };
	}
	const merged: Record<string, unknown> = { ...existingConfig };
	for (const [key, patchVal] of Object.entries(patch)) {
		const existingVal = existingConfig[key];
		if (Array.isArray(existingVal) && Array.isArray(patchVal)) {
			const combined = [...existingVal, ...patchVal];
			const seen = new Set<unknown>();
			merged[key] = combined.filter((item) => {
				const token =
					item !== null && typeof item === "object" ? JSON.stringify(item) : item;
				if (seen.has(token)) return false;
				seen.add(token);
				return true;
			});
		} else if (Array.isArray(patchVal)) {
			const seen = new Set<unknown>();
			merged[key] = patchVal.filter((item) => {
				const token =
					item !== null && typeof item === "object" ? JSON.stringify(item) : item;
				if (seen.has(token)) return false;
				seen.add(token);
				return true;
			});
		} else {
			merged[key] = patchVal;
		}
	}
	return merged;
}

export function formatIntegrationSetMcp(output: IntegrationSetOutput): string {
	if (output.status === "noop") {
		return "No fields supplied. Provide `config` (a patch to merge) and/or `enabled`.";
	}
	const verb = output.status === "created" ? "Created" : "Updated";
	return [
		`${verb} integration '${output.provider}' (enabled: ${output.enabled}).`,
		"config keys: " + output.config_keys.join(", "),
	].join("\n");
}

export function createIntegrationSetAction(repo: ConfigRepository) {
	return defineAction({
		id: "integration_set",
		domain: "integrations",
		description:
			"Upsert a user_integrations row for one provider: create it if missing, otherwise MERGE `config` into what is there — keys you do not mention are left untouched, so this never wipes a row. Use when the owner explicitly names a typed integration setting. Full notes: docs/guides/tools/integration_set.md",
		schema: integrationSetSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<IntegrationSetOutput> => {
			const { provider, config: patch, enabled, merge_arrays } = args;

			if (patch === undefined && enabled === undefined) {
				return {
					status: "noop",
					provider,
					enabled: false,
					config_keys: [],
				};
			}

			if (!repo.readIntegrationConfig || !repo.insertIntegrationConfig || !repo.updateIntegrationConfigRow) {
				throw new Error("ConfigRepository write methods are not wired");
			}

			const schema = resolveConfigSchema(provider);
			const current = await repo.readIntegrationConfig(provider);

			const existingConfig = current?.config ?? {};
			const mergedConfig =
				patch !== undefined
					? mergeConfigValues(existingConfig, patch, Boolean(merge_arrays))
					: existingConfig;

			if (schema) {
				const parsed = schema.safeParse(mergedConfig);
				if (!parsed.success) {
					throw new Error(
						`Config for '${provider}' does not match its schema: ${parsed.error.message}`,
					);
				}
			} else {
				const parsed = genericConfigSchema.safeParse(mergedConfig);
				if (!parsed.success) {
					throw new Error(
						`Invalid config for unknown provider '${provider}': values must be string, number, boolean, or null. ${parsed.error.message}`,
					);
				}
			}

			if (!current) {
				const inserted = await repo.insertIntegrationConfig(provider, {
					config: mergedConfig,
					enabled: enabled ?? true,
				});
				const persistedConfig = inserted.config ?? {};
				return {
					status: "created",
					provider,
					enabled: inserted.enabled,
					config_keys: Object.keys(persistedConfig),
					config: redactIntegrationConfig(persistedConfig),
				};
			}

			const updated = await repo.updateIntegrationConfigRow(provider, {
				config: mergedConfig,
				enabled,
			});
			const persistedConfig = updated.config ?? {};

			return {
				status: "updated",
				provider,
				enabled: updated.enabled,
				config_keys: Object.keys(persistedConfig),
				config: redactIntegrationConfig(persistedConfig),
			};
		},
		formatMcp: formatIntegrationSetMcp,
	});
}

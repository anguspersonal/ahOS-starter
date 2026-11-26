import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import {
	capturePreferencesSchema,
	DEFAULT_CAPTURE_PREFERENCES,
	type CapturePreferences,
} from "../../domain/capturePreferences.js";
import {
	DEFAULT_MEETING_NOTE_SOURCES,
	meetingNoteSourcesSchema,
} from "../../domain/ingest/meetingNoteEmails.js";
import {
	redactIntegrationConfig,
	type IntegrationConfigResult,
	type IntegrationRouting,
	type IntegrationRow,
	type IntegrationSummary,
} from "../../domain/integrations.js";
import type {
	ConfigRepository,
	IntegrationConfigWriteRow,
	MeetingNoteSourcesResult,
	PastedInstructionsRecord,
	UserPreferencesRow,
} from "../../ports/config.js";

function extractPastedInstructionsFromDosConfig(
	dosConfig: Record<string, unknown> | null | undefined,
): PastedInstructionsRecord | null {
	if (!dosConfig || typeof dosConfig !== "object") return null;
	const candidates = [
		dosConfig.system_instructions_sync,
		dosConfig.claude_instructions_sync,
		dosConfig.pasted_instructions,
	];
	for (const candidate of candidates) {
		if (candidate && typeof candidate === "object") {
			const record = candidate as Record<string, unknown>;
			if (typeof record.sha256 === "string" && typeof record.pasted_at === "string") {
				return { sha256: record.sha256, pasted_at: record.pasted_at };
			}
		}
	}
	return null;
}

export type ConfigSupabaseClient = Pick<SupabaseClient, "from">;

export interface SupabaseConfigRepositoryOptions {
	client: ConfigSupabaseClient;
	ownerId: string | (() => string);
}

export function createSupabaseConfigRepository(
	options: SupabaseConfigRepositoryOptions,
): Required<ConfigRepository> {
	const resolveOwnerId = () =>
		typeof options.ownerId === "function" ? options.ownerId() : options.ownerId;

	const repo: Required<ConfigRepository> = {
		async loadConfigDetailed<T>(
			provider: string,
			schema: z.ZodType<T>,
		): Promise<IntegrationConfigResult<T>> {
			const { data, error } = await options.client
				.from("user_integrations")
				.select("config, enabled")
				.eq("user_id", resolveOwnerId())
				.eq("provider", provider)
				.maybeSingle();

			if (error) return { status: "error", error };
			if (!data || data.enabled === false) return { status: "unwired" };

			const parsed = schema.safeParse(data.config);
			return parsed.success
				? { status: "ok", data: parsed.data }
				: { status: "unwired" };
		},

		async loadConfig<T>(provider: string, schema: z.ZodType<T>): Promise<T | null> {
			const result = await repo.loadConfigDetailed(provider, schema);
			return result.status === "ok" ? result.data : null;
		},

		async loadIntegration(provider: string): Promise<IntegrationRow | null> {
			const { data, error } = await options.client
				.from("user_integrations")
				.select("provider, routing, status, enabled, credential_ref, config")
				.eq("user_id", resolveOwnerId())
				.eq("provider", provider)
				.maybeSingle();

			if (error || !data) return null;

			return {
				provider: data.provider as string,
				routing: (data.routing as IntegrationRouting) ?? "native",
				status: (data.status as string) ?? "connected",
				enabled: (data.enabled as boolean) ?? true,
				credential_ref: (data.credential_ref as string | null) ?? null,
				config: (data.config as Record<string, unknown>) ?? {},
			};
		},

		async listByFamily(family: string): Promise<IntegrationRow[]> {
			const { data, error } = await options.client
				.from("user_integrations")
				.select("provider, routing, status, enabled, credential_ref, config")
				.eq("user_id", resolveOwnerId())
				.like("provider", `${family}:%`)
				.order("provider");

			if (error || !data) return [];

			return data
				.filter((row: Record<string, unknown>) => (row.enabled as boolean) !== false)
				.map((row: Record<string, unknown>) => ({
					provider: row.provider as string,
					routing: (row.routing as IntegrationRouting) ?? "own_substrate",
					status: (row.status as string) ?? "connected",
					enabled: true,
					credential_ref: (row.credential_ref as string | null) ?? null,
					config: (row.config as Record<string, unknown>) ?? {},
				}));
		},

		async updateConfig(provider: string, patch: Record<string, unknown>): Promise<void> {
			const current = await repo.loadIntegration(provider);
			const merged = { ...(current?.config ?? {}), ...patch };
			await options.client
				.from("user_integrations")
				.update({ config: merged })
				.eq("user_id", resolveOwnerId())
				.eq("provider", provider);
		},

		async listIntegrations(): Promise<IntegrationSummary[]> {
			const { data, error } = await options.client
				.from("user_integrations")
				.select("provider, enabled, routing, status, config")
				.eq("user_id", resolveOwnerId());

			if (error || !data) return [];

			return data.map((row: Record<string, unknown>) => {
				const rawConfig = (row.config as Record<string, unknown>) ?? {};
				return {
					provider: row.provider as string,
					enabled: (row.enabled as boolean) ?? true,
					routing: (row.routing as string) ?? "native",
					status: (row.status as string) ?? "connected",
					config_keys: Object.keys(rawConfig),
					config: redactIntegrationConfig(rawConfig),
				};
			});
		},

		async readIntegrationConfig(
			provider: string,
		): Promise<{ config: Record<string, unknown>; enabled: boolean } | null> {
			const { data, error } = await options.client
				.from("user_integrations")
				.select("config, enabled")
				.eq("user_id", resolveOwnerId())
				.eq("provider", provider)
				.maybeSingle();

			if (error) {
				throw new Error(
					`Failed to read existing user_integrations row for '${provider}': ${error.message}`,
				);
			}
			if (!data) return null;
			return {
				config: (data.config as Record<string, unknown>) ?? {},
				enabled: (data.enabled as boolean) ?? true,
			};
		},

		async insertIntegrationConfig(
			provider: string,
			row: { config: Record<string, unknown>; enabled: boolean },
		): Promise<IntegrationConfigWriteRow> {
			const { data, error } = await options.client
				.from("user_integrations")
				.insert({
					user_id: resolveOwnerId(),
					provider,
					config: row.config,
					enabled: row.enabled,
				})
				.select("provider, enabled, config")
				.single();

			if (error) {
				throw new Error(
					`Failed to create user_integrations row for '${provider}': ${error.message}`,
				);
			}
			return {
				provider: data.provider as string,
				enabled: data.enabled as boolean,
				config: (data.config as Record<string, unknown>) ?? {},
			};
		},

		async updateIntegrationConfigRow(
			provider: string,
			patch: { config: Record<string, unknown>; enabled?: boolean },
		): Promise<IntegrationConfigWriteRow> {
			const updatePatch: Record<string, unknown> = { config: patch.config };
			if (patch.enabled !== undefined) updatePatch.enabled = patch.enabled;

			const { data, error } = await options.client
				.from("user_integrations")
				.update(updatePatch)
				.eq("user_id", resolveOwnerId())
				.eq("provider", provider)
				.select("provider, enabled, config")
				.single();

			if (error) {
				throw new Error(
					`Failed to update user_integrations row for '${provider}': ${error.message}`,
				);
			}
			return {
				provider: data.provider as string,
				enabled: data.enabled as boolean,
				config: (data.config as Record<string, unknown>) ?? {},
			};
		},

		async loadPreferencesRow(): Promise<UserPreferencesRow | null> {
			const { data, error } = await options.client
				.from("user_preferences")
				.select("*")
				.eq("user_id", resolveOwnerId())
				.maybeSingle();

			if (error) {
				throw new Error(`Failed to read user_preferences: ${error.message}`);
			}
			return (data as UserPreferencesRow | null) ?? null;
		},

		async loadCapturePreferences(): Promise<CapturePreferences> {
			const { data, error } = await options.client
				.from("user_preferences")
				.select("capture_preferences")
				.eq("user_id", resolveOwnerId())
				.maybeSingle();

			if (error || !data?.capture_preferences) {
				return DEFAULT_CAPTURE_PREFERENCES;
			}

			const parsed = capturePreferencesSchema.safeParse(data.capture_preferences);
			return parsed.success ? parsed.data : DEFAULT_CAPTURE_PREFERENCES;
		},

		async loadDosConfigRow(): Promise<unknown> {
			const { data, error } = await options.client
				.from("user_preferences")
				.select("dos_config")
				.eq("user_id", resolveOwnerId())
				.maybeSingle();

			if (error || !data?.dos_config) {
				return null;
			}

			return data.dos_config;
		},

		async loadPastedInstructions(): Promise<PastedInstructionsRecord | null> {
			const { data, error } = await options.client
				.from("user_preferences")
				.select("dos_config")
				.eq("user_id", resolveOwnerId())
				.maybeSingle();

			if (error || !data) return null;
			return extractPastedInstructionsFromDosConfig(
				data.dos_config as Record<string, unknown> | null,
			);
		},

		async savePastedInstructions(
			sha256OrRecord: string | PastedInstructionsRecord,
			pastedAt?: string,
		): Promise<void> {
			const userId = resolveOwnerId();
			const { data, error: readError } = await options.client
				.from("user_preferences")
				.select("dos_config")
				.eq("user_id", userId)
				.maybeSingle();

			if (readError) {
				throw new Error(`Failed to read user_preferences: ${readError.message}`);
			}

			const syncRecord: PastedInstructionsRecord =
				typeof sha256OrRecord === "string"
					? {
							sha256: sha256OrRecord,
							pasted_at: pastedAt ?? new Date().toISOString(),
					  }
					: sha256OrRecord;

			const existingDosConfig = (data?.dos_config as Record<string, unknown>) ?? {};
			const updatedDosConfig = {
				...existingDosConfig,
				system_instructions_sync: syncRecord,
				pasted_instructions: syncRecord,
			};

			const { error: writeError } = await options.client
				.from("user_preferences")
				.update({ dos_config: updatedDosConfig })
				.eq("user_id", userId);

			if (writeError) {
				throw new Error(`Failed to update user_preferences.dos_config: ${writeError.message}`);
			}
		},

		async meetingNoteSources(userId?: string): Promise<MeetingNoteSourcesResult> {
			const targetUserId = userId ?? resolveOwnerId();
			const { data, error } = await options.client
				.from("user_preferences")
				.select("*")
				.eq("user_id", targetUserId)
				.maybeSingle();

			if (error || !data) {
				return { sources: DEFAULT_MEETING_NOTE_SOURCES, origin: "default" };
			}

			const raw = (data as Record<string, unknown>).meeting_note_sources;
			if (raw === undefined || raw === null) {
				return { sources: DEFAULT_MEETING_NOTE_SOURCES, origin: "default" };
			}

			const parsed = meetingNoteSourcesSchema.safeParse(raw);
			if (!parsed.success || parsed.data.length === 0) {
				return { sources: DEFAULT_MEETING_NOTE_SOURCES, origin: "invalid-stored" };
			}
			return { sources: parsed.data, origin: "stored" };
		},
	};

	return repo;
}

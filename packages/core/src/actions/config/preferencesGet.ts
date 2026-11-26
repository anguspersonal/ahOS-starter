import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ConfigRepository, DosConfigRecord, UserPreferencesRow } from "../../ports/config.js";

export const configPreferencesGetInput = {} as const;
export const configPreferencesGetSchema = z.object(configPreferencesGetInput);

export interface ConfigPreferencesGetOutput {
	row: UserPreferencesRow | null;
}

export function extractDosConfigFromPreferences(
	row: UserPreferencesRow | null | undefined,
): DosConfigRecord | null {
	if (!row || !row.dos_config || typeof row.dos_config !== "object" || Array.isArray(row.dos_config)) {
		return null;
	}
	return row.dos_config as DosConfigRecord;
}

export function formatConfigPreferencesGetMcp(output: ConfigPreferencesGetOutput): string {
	const data = output.row;
	if (!data) {
		return "No user_preferences row found for this user. It is created automatically on first login via the app, or you can seed one via the DB function config_preferences_get().";
	}

	const indentJson = (val: unknown) =>
		JSON.stringify(val ?? null, null, 2)
			.split("\n")
			.map((l) => "  " + l)
			.join("\n");

	return [
		"user_preferences row:",
		`  user_id:                    ${data.user_id}`,
		`  user_mode:                  ${data.user_mode ?? "(unset)"}`,
		`  automation_level:           ${data.automation_level ?? "(unset)"}`,
		`  global_confidence_threshold: ${data.global_confidence_threshold ?? "(unset)"}`,
		`  show_lifecycle_details:     ${data.show_lifecycle_details ?? "(unset)"}`,
		`  safe_mode:                  ${data.safe_mode ?? "(unset)"}`,
		`  has_completed_onboarding:   ${data.has_completed_onboarding ?? "(unset)"}`,
		`  created_at:                 ${data.created_at}`,
		`  updated_at:                 ${data.updated_at}`,
		"",
		"confidence_thresholds (JSONB):",
		indentJson(data.confidence_thresholds),
		"",
		"notification_preferences (JSONB):",
		indentJson(data.notification_preferences),
		"",
		"capture_preferences (JSONB):",
		indentJson(data.capture_preferences),
		"",
		"dos_config (JSONB):",
		indentJson(data.dos_config),
		"",
		"identity (JSONB):",
		indentJson(data.identity),
	].join("\n");
}

export function createConfigPreferencesGetAction(repo: ConfigRepository) {
	return defineAction({
		id: "config_preferences_get",
		domain: "ops",
		description:
			"Return the owner's complete user_preferences row: all scalar settings (user_mode, automation_level, global_confidence_threshold, show_lifecycle_details, safe_mode, has_completed_onboarding) plus the raw JSONB blobs (confidence_thresholds, notification_preferences, capture_preferences, dos_config, identity — the owner's emails and display_name). Use this for a full picture before deciding what to update, or to inspect blobs without running the dedicated config_capture_get / dos_config_get tools.",
		schema: configPreferencesGetSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (): Promise<ConfigPreferencesGetOutput> => {
			if (!repo.loadPreferencesRow) {
				throw new Error("ConfigRepository.loadPreferencesRow is not wired");
			}
			const row = await repo.loadPreferencesRow();
			return { row };
		},
		formatMcp: formatConfigPreferencesGetMcp,
	});
}

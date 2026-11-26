import { z } from "zod";
import { defineAction } from "../defineAction.js";
import {
	effectiveSurfaceRoleMap,
	type CapturePreferences,
} from "../../domain/capturePreferences.js";
import type { ConfigRepository } from "../../ports/config.js";

export const configCaptureGetInput = {} as const;
export const configCaptureGetSchema = z.object(configCaptureGetInput);

export interface ConfigCaptureGetOutput {
	preferences: CapturePreferences;
	effective_surface_role_map: Record<string, string>;
}

export function formatConfigCaptureGetMcp(output: ConfigCaptureGetOutput): string {
	const prefs = output.preferences;
	const rules =
		prefs.tag_rules.length === 0
			? "  (none)"
			: prefs.tag_rules
					.map(
						(r) =>
							`  • /${r.match}/i on ${r.in} → tags [${r.tags.join(", ")}]` +
							(r.source_channel ? ` channel "${r.source_channel}"` : ""),
					)
					.join("\n");

	return [
		"Persisted capture context (user_preferences.capture_preferences):",
		`default_tags: ${prefs.default_tags.length ? prefs.default_tags.join(", ") : "(none)"}`,
		`default_source_channel: ${prefs.default_source_channel}`,
		`default_surface: ${prefs.default_surface ?? "(none)"}`,
		`default_trust: ${prefs.default_trust}`,
		`surface_trust_map: ${Object.keys(prefs.surface_trust_map).length ? JSON.stringify(prefs.surface_trust_map) : "(none)"}`,
		`default_role: ${prefs.default_role}`,
		`surface_role_map (stored): ${Object.keys(prefs.surface_role_map).length ? JSON.stringify(prefs.surface_role_map) : "(none)"}`,
		`surface_role_map (effective, stored over shipped seed): ${JSON.stringify(output.effective_surface_role_map)}`,
		`create_derived_artifacts: ${prefs.create_derived_artifacts}`,
		"tag_rules:",
		rules,
		"",
		"Raw JSON:",
		JSON.stringify(prefs, null, 2),
	].join("\n");
}

export function createConfigCaptureGetAction(repo: ConfigRepository) {
	return defineAction({
		id: "config_capture_get",
		domain: "ops",
		description:
			"Show the owner's persisted, user-specific capture context (default tags, source channel, and tag routing rules) from user_preferences. Use to see how captures will be tagged/routed.",
		schema: configCaptureGetSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (): Promise<ConfigCaptureGetOutput> => {
			if (!repo.loadCapturePreferences) {
				throw new Error("ConfigRepository.loadCapturePreferences is not wired");
			}
			const preferences = await repo.loadCapturePreferences();
			return {
				preferences,
				effective_surface_role_map: effectiveSurfaceRoleMap(preferences),
			};
		},
		formatMcp: formatConfigCaptureGetMcp,
	});
}

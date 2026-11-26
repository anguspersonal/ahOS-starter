import { describe, expect, it, vi } from "vitest";
import {
	capturePreferencesSchema,
	DEFAULT_CAPTURE_PREFERENCES,
} from "../../domain/capturePreferences.js";
import type { ConfigRepository } from "../../ports/config.js";
import { createConfigCaptureGetAction, formatConfigCaptureGetMcp } from "./captureGet.js";

describe("createConfigCaptureGetAction", () => {
	const mockRepo = (prefs = DEFAULT_CAPTURE_PREFERENCES): ConfigRepository => ({
		loadConfigDetailed: vi.fn(),
		loadConfig: vi.fn(),
		loadIntegration: vi.fn(),
		listByFamily: vi.fn(),
		updateConfig: vi.fn(),
		listIntegrations: vi.fn(),
		loadCapturePreferences: vi.fn().mockResolvedValue(prefs),
	});

	it("returns capture preferences with effective surface role map and formats MCP output", async () => {
		const prefs = capturePreferencesSchema.parse({
			default_tags: ["ops"],
			tag_rules: [{ match: "work", in: "text", tags: ["work"], source_channel: "slack" }],
		});
		const action = createConfigCaptureGetAction(mockRepo(prefs));
		const out = await action.run({}, { caller: "mcp", requestId: "req-1" });
		expect(out.preferences.default_tags).toEqual(["ops"]);
		expect(out.effective_surface_role_map.discovered_google_drive).toBe("evidence");

		const text = formatConfigCaptureGetMcp(out);
		expect(text).toContain("Persisted capture context (user_preferences.capture_preferences):");
		expect(text).toContain("default_tags: ops");
		expect(text).toContain('• /work/i on text → tags [work] channel "slack"');
	});
});

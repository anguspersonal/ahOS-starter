import { describe, expect, it, vi } from "vitest";
import type { ConfigRepository, UserPreferencesRow } from "../../ports/config.js";
import {
	createConfigPreferencesGetAction,
	extractDosConfigFromPreferences,
	formatConfigPreferencesGetMcp,
} from "./preferencesGet.js";

describe("createConfigPreferencesGetAction", () => {
	const mockRepo = (row: UserPreferencesRow | null): ConfigRepository => ({
		loadConfigDetailed: vi.fn(),
		loadConfig: vi.fn(),
		loadIntegration: vi.fn(),
		listByFamily: vi.fn(),
		updateConfig: vi.fn(),
		listIntegrations: vi.fn(),
		loadPreferencesRow: vi.fn().mockResolvedValue(row),
	});

	it("formats missing user_preferences row message", async () => {
		const action = createConfigPreferencesGetAction(mockRepo(null));
		const out = await action.run({}, { caller: "mcp", requestId: "req-1" });
		expect(out).toEqual({ row: null });
		expect(formatConfigPreferencesGetMcp(out)).toContain("No user_preferences row found for this user.");
	});

	it("returns and formats full user_preferences row", async () => {
		const row: UserPreferencesRow = {
			user_id: "user-1",
			user_mode: "solo",
			automation_level: "assisted",
			global_confidence_threshold: 0.8,
			show_lifecycle_details: true,
			safe_mode: false,
			has_completed_onboarding: true,
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-02T00:00:00Z",
			confidence_thresholds: { entity: 0.7 },
			notification_preferences: { email: false },
			capture_preferences: { default_tags: ["ops"] },
			dos_config: { timezone: "UTC" },
		};
		const action = createConfigPreferencesGetAction(mockRepo(row));
		const out = await action.run({}, { caller: "mcp", requestId: "req-1" });
		expect(out).toEqual({ row });
		const text = formatConfigPreferencesGetMcp(out);
		expect(text).toContain("user_preferences row:");
		expect(text).toContain("user_id:                    user-1");
		expect(text).toContain("capture_preferences (JSONB):");
		expect(text).toContain('"default_tags": [');
		expect(text).toContain("dos_config (JSONB):");
		expect(text).toContain('"timezone": "UTC"');
		expect(extractDosConfigFromPreferences(out.row)).toEqual({ timezone: "UTC" });
		expect(extractDosConfigFromPreferences(null)).toBeNull();
	});

	it("prints the identity blob so email fallbacks can read it over MCP (#2415)", () => {
		const text = formatConfigPreferencesGetMcp({
			row: {
				user_id: "user-1",
				identity: { emails: ["a@example.com"], display_name: "A" },
			},
		});
		const section = text.split("identity (JSONB):\n")[1];
		expect(section).toBeDefined();
		expect(section).toContain('"a@example.com"');
		expect(section).toContain('"display_name": "A"');
	});

	it("prints null for a missing identity blob, as the other blobs do (#2415)", () => {
		const text = formatConfigPreferencesGetMcp({ row: { user_id: "user-1" } });
		expect(text).toContain("identity (JSONB):\n  null");
	});

	it("lists identity among the blobs in the action description (#2415)", () => {
		const action = createConfigPreferencesGetAction(mockRepo(null));
		expect(action.description).toMatch(/JSONB blobs \([^)]*\bidentity\b[^)]*\)/);
	});
});

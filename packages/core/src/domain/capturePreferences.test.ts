import { describe, expect, it } from "vitest";
import {
	applyCaptureRouting,
	capturePreferencesSchema,
	DEFAULT_CAPTURE_PREFERENCES,
	DISCOVER_ROLE_SEED,
	effectiveSurfaceRoleMap,
	isRobotAuthoredArtifact,
	resolveSynthesisRole,
	resolveTrust,
	roleTierFilters,
} from "./capturePreferences.js";

describe("capturePreferences domain", () => {
	it("parses defaults and resolves trust/role precedence", () => {
		const prefs = capturePreferencesSchema.parse({
			default_trust: "low",
			surface_trust_map: { mcp: "high" },
			surface_role_map: { discovered_google_drive: "narrative" },
		});
		expect(resolveTrust(prefs, { surface: "mcp" })).toBe("high");
		expect(resolveTrust(prefs, { trust_override: "perfect", surface: "mcp" })).toBe("perfect");
		expect(resolveTrust(prefs, {})).toBe("low");
		expect(effectiveSurfaceRoleMap(DEFAULT_CAPTURE_PREFERENCES)).toMatchObject(DISCOVER_ROLE_SEED);
		expect(resolveSynthesisRole(DEFAULT_CAPTURE_PREFERENCES, { surface: "discovered_google_drive" })).toBe("evidence");
		expect(resolveSynthesisRole(DEFAULT_CAPTURE_PREFERENCES, { surface: "kpi_snapshot" })).toBe("metrics");
		expect(resolveSynthesisRole(prefs, { surface: "discovered_google_drive" })).toBe("narrative");
		expect(isRobotAuthoredArtifact({ tags: ["robot_authored"] })).toBe(true);
		expect(resolveSynthesisRole(prefs, { tags: ["robot_authored"], surface: "discovered_google_drive" })).toBe("excluded");
	});

	it("applies capture routing and builds roleTierFilters", () => {
		const prefs = capturePreferencesSchema.parse({
			default_tags: ["base"],
			default_source_channel: "mcp",
			tag_rules: [{ match: "work", in: "text", tags: ["work"], source_channel: "slack" }],
		});
		expect(applyCaptureRouting(prefs, { text: "Work launch", title: "Note", tags: ["custom"] })).toEqual({
			tags: ["base", "custom", "work"],
			source_channel: "slack",
		});
		const filters = roleTierFilters(DEFAULT_CAPTURE_PREFERENCES);
		expect(filters.map((f) => f.role)).toEqual(["narrative", "evidence", "metrics", "excluded"]);
	});
});

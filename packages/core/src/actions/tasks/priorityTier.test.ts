import { describe, expect, it } from "vitest";
import {
	DEFAULT_PRIORITY_CANDIDATES,
	type NotionDatabaseProperty,
	PRIORITY_TIERS,
	priorityLevelToLegacyTier,
	resolvePriorityLevel,
	resolvePriorityTier,
} from "./taskProperties.js";

function selectProp(options: string[], name = "Priority"): NotionDatabaseProperty {
	return { name, type: "select", options };
}

describe("resolvePriorityTier (#1920)", () => {
	it("resolves Low, Medium, High (Work shape) to High, Medium, Low for tiers 1..3", () => {
		const props = [selectProp(["Low", "Medium", "High"])];
		expect(resolvePriorityTier(props, "Priority", 1)).toEqual({ applied: "High" });
		expect(resolvePriorityTier(props, "Priority", 2)).toEqual({ applied: "Medium" });
		expect(resolvePriorityTier(props, "Priority", 3)).toEqual({ applied: "Low" });
	});

	it("resolves 1 High, 2 Medium, 3 Low, High (personal shape) to the numbered options, never stray High", () => {
		const props = [selectProp(["1 High", "2 Medium", "3 Low", "High"])];
		expect(resolvePriorityTier(props, "Priority", 1)).toEqual({ applied: "1 High" });
		expect(resolvePriorityTier(props, "Priority", 2)).toEqual({ applied: "2 Medium" });
		expect(resolvePriorityTier(props, "Priority", 3)).toEqual({ applied: "3 Low" });
	});

	it("resolves P0..P3 to P1 for tier 1 (never P0 when P1 exists), P2 for tier 2, P3 for tier 3", () => {
		const props = [selectProp(["P0", "P1", "P2", "P3"])];
		expect(resolvePriorityTier(props, "Priority", 1)).toEqual({ applied: "P1" });
		expect(resolvePriorityTier(props, "Priority", 2)).toEqual({ applied: "P2" });
		expect(resolvePriorityTier(props, "Priority", 3)).toEqual({ applied: "P3" });
	});

	it("returns skipped: 'no-tier-option' with tried and live options when options are Urgent, Normal", () => {
		const props = [selectProp(["Urgent", "Normal"])];
		for (const tier of [1, 2, 3] as const) {
			expect(resolvePriorityTier(props, "Priority", tier)).toEqual({
				skipped: "no-tier-option",
				tried: [...PRIORITY_TIERS[tier]],
				options: ["Urgent", "Normal"],
			});
		}
	});

	it("resolves a status-type property like select, and returns skipped: 'property-missing' for rich_text or missing property", () => {
		const statusProps: NotionDatabaseProperty[] = [
			{ name: "Priority", type: "status", options: ["Low", "Medium", "High"] },
		];
		expect(resolvePriorityTier(statusProps, "Priority", 1)).toEqual({ applied: "High" });

		const richTextProps: NotionDatabaseProperty[] = [{ name: "Priority", type: "rich_text" }];
		expect(resolvePriorityTier(richTextProps, "Priority", 1)).toEqual({
			skipped: "property-missing",
			tried: [...PRIORITY_TIERS[1]],
			options: [],
		});

		expect(resolvePriorityTier([], "Priority", 1)).toEqual({
			skipped: "property-missing",
			tried: [...PRIORITY_TIERS[1]],
			options: [],
		});
	});

	it("includes every entry of DEFAULT_PRIORITY_CANDIDATES in PRIORITY_TIERS[1]", () => {
		for (const candidate of DEFAULT_PRIORITY_CANDIDATES) {
			expect(PRIORITY_TIERS[1]).toContain(candidate);
		}
	});

	it("maps canonical 7-point priority_level (1..7) onto Notion options via resolvePriorityLevel (#1986)", () => {
		expect(priorityLevelToLegacyTier(7)).toBe(1);
		expect(priorityLevelToLegacyTier(6)).toBe(1);
		expect(priorityLevelToLegacyTier(5)).toBe(1);
		expect(priorityLevelToLegacyTier(4)).toBe(2);
		expect(priorityLevelToLegacyTier(3)).toBe(2);
		expect(priorityLevelToLegacyTier(2)).toBe(3);
		expect(priorityLevelToLegacyTier(1)).toBe(3);

		const props = [selectProp(["Low", "Medium", "High"])];
		expect(resolvePriorityLevel(props, "Priority", 7)).toEqual({ applied: "High" });
		expect(resolvePriorityLevel(props, "Priority", 5)).toEqual({ applied: "High" });
		expect(resolvePriorityLevel(props, "Priority", 4)).toEqual({ applied: "Medium" });
		expect(resolvePriorityLevel(props, "Priority", 3)).toEqual({ applied: "Medium" });
		expect(resolvePriorityLevel(props, "Priority", 2)).toEqual({ applied: "Low" });
		expect(resolvePriorityLevel(props, "Priority", 1)).toEqual({ applied: "Low" });
	});
});

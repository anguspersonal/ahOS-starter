import { describe, expect, it } from "vitest";
import {
	DEFAULT_PRIORITY_CUT_LINE,
	formatPriorityBadge,
	fromExternalPriority,
	getPriorityLevelBySlug,
	getPriorityLevelDefinition,
	isPriorityLevel,
	isPriorityLevelSlug,
	mapPriorityToSurface,
	mapSurfaceToPriorityLevel,
	notionSelectToPriorityLevel,
	notionTierToPriorityLevel,
	PRIORITY_LEVEL_NUMBERS,
	PRIORITY_LEVEL_SLUGS,
	PRIORITY_LEVEL_TITLES,
	PRIORITY_LEVELS,
	PRIORITY_SURFACE_MAPPINGS,
	PRIORITY_SURFACES,
	priorityLevelToNotionSelect,
	priorityLevelToNotionTier,
	priorityLevelToTaskCrudPriority,
	priorityLevelToTaskPriority,
	priorityLevelToTier,
	priorityTierToLevel,
	priorityTierToNotionSelect,
	resolveEffectivePriorityLevel,
	taskCrudPriorityToPriorityLevel,
	taskPriorityToLevel,
	toExternalPriority,
} from "./priorityScale.js";

describe("priorityScale (ADR-116, #1986)", () => {
	it("defines 7 monotonic priority levels from 1 (Trivial) to 7 (Critical) with cut-line at 5 (High)", () => {
		expect(PRIORITY_LEVEL_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(PRIORITY_LEVEL_TITLES).toEqual([
			"Trivial",
			"Minor",
			"Low",
			"Normal",
			"High",
			"Urgent",
			"Critical",
		]);
		expect(DEFAULT_PRIORITY_CUT_LINE).toBe(5);
		expect(PRIORITY_LEVELS).toHaveLength(7);
		expect(PRIORITY_LEVEL_SLUGS).toEqual([
			"trivial",
			"minor",
			"low",
			"normal",
			"high",
			"urgent",
			"critical",
		]);

		for (const row of PRIORITY_LEVELS) {
			expect(row.id).toBe(row.level);
			expect(row.display).toBe(row.title);
			expect(row.meaning).toBe(row.description);
			expect(isPriorityLevelSlug(row.slug)).toBe(true);
			expect(getPriorityLevelBySlug(row.slug)).toEqual(row);
		}
		expect(isPriorityLevelSlug("unknown")).toBe(false);

		const cutLineLevels = PRIORITY_LEVELS.filter((row) => row.isDefaultCutLine);
		expect(cutLineLevels).toHaveLength(1);
		expect(cutLineLevels[0]?.level).toBe(5);
		expect(cutLineLevels[0]?.title).toBe("High");
	});

	it("formats priority badges with tier, canonical title, and X/7 fraction", () => {
		expect(formatPriorityBadge(1)).toBe("P1 Trivial (1/7)");
		expect(formatPriorityBadge(4)).toBe("P4 Normal (4/7)");
		expect(formatPriorityBadge(5)).toBe("P5 High (5/7)");
		expect(formatPriorityBadge(7)).toBe("P7 Critical (7/7)");
		expect(getPriorityLevelDefinition(6).title).toBe("Urgent");
	});

	it("validates integer priority levels 1..7 via isPriorityLevel", () => {
		for (const level of PRIORITY_LEVEL_NUMBERS) {
			expect(isPriorityLevel(level)).toBe(true);
		}
		expect(isPriorityLevel(0)).toBe(false);
		expect(isPriorityLevel(8)).toBe(false);
		expect(isPriorityLevel(3.5)).toBe(false);
		expect(isPriorityLevel("5")).toBe(false);
		expect(isPriorityLevel(null)).toBe(false);
	});

	it("converts between P1..P7 tiers, 1..7 levels, Notion tiers/selects, and task_crud coarse priority", () => {
		expect(priorityTierToLevel("P1")).toBe(1);
		expect(priorityTierToLevel("P7")).toBe(7);
		expect(priorityLevelToTier(1)).toBe("P1");
		expect(priorityLevelToTier(7)).toBe("P7");

		expect(priorityLevelToNotionTier(1)).toBe(3);
		expect(priorityLevelToNotionTier(2)).toBe(3);
		expect(priorityLevelToNotionTier(3)).toBe(2);
		expect(priorityLevelToNotionTier(4)).toBe(2);
		expect(priorityLevelToNotionTier(5)).toBe(1);
		expect(priorityLevelToNotionTier(6)).toBe(1);
		expect(priorityLevelToNotionTier(7)).toBe(1);

		expect(notionTierToPriorityLevel(1)).toBe(6);
		expect(notionTierToPriorityLevel(2)).toBe(4);
		expect(notionTierToPriorityLevel(3)).toBe(2);

		expect(priorityLevelToNotionSelect(1)).toBe("Low");
		expect(priorityLevelToNotionSelect(2)).toBe("Low");
		expect(priorityLevelToNotionSelect(3)).toBe("Medium");
		expect(priorityLevelToNotionSelect(4)).toBe("Medium");
		expect(priorityLevelToNotionSelect(5)).toBe("High");
		expect(priorityLevelToNotionSelect(6)).toBe("High");
		expect(priorityLevelToNotionSelect(7)).toBe("High");
		expect(priorityLevelToNotionSelect(0)).toBeUndefined();

		expect(priorityTierToNotionSelect("p1")).toBe("Low");
		expect(priorityTierToNotionSelect("P4")).toBe("Medium");
		expect(priorityTierToNotionSelect("P7")).toBe("High");

		expect(notionSelectToPriorityLevel("3 Low")).toBe(2);
		expect(notionSelectToPriorityLevel("Low")).toBe(2);
		expect(notionSelectToPriorityLevel("2 Medium")).toBe(4);
		expect(notionSelectToPriorityLevel("Medium")).toBe(4);
		expect(notionSelectToPriorityLevel("1 High")).toBe(6);
		expect(notionSelectToPriorityLevel("High")).toBe(6);

		expect(priorityLevelToTaskCrudPriority(1)).toBe("low");
		expect(priorityLevelToTaskCrudPriority(2)).toBe("low");
		expect(priorityLevelToTaskCrudPriority(3)).toBe("medium");
		expect(priorityLevelToTaskCrudPriority(4)).toBe("medium");
		expect(priorityLevelToTaskCrudPriority(5)).toBe("high");
		expect(priorityLevelToTaskCrudPriority(6)).toBe("urgent");
		expect(priorityLevelToTaskCrudPriority(7)).toBe("urgent");

		expect(taskCrudPriorityToPriorityLevel("low")).toBe(2);
		expect(taskCrudPriorityToPriorityLevel("medium")).toBe(4);
		expect(taskCrudPriorityToPriorityLevel("high")).toBe(5);
		expect(taskCrudPriorityToPriorityLevel("urgent")).toBe(6);

		expect(priorityLevelToTaskPriority(1)).toBe("low");
		expect(priorityLevelToTaskPriority(5)).toBe("high");
		expect(priorityLevelToTaskPriority(7)).toBe("urgent");
		expect(taskPriorityToLevel("low")).toBe(2);
		expect(taskPriorityToLevel("urgent")).toBe(6);
	});

	it("defines all 35 cross-surface mappings (5 surfaces x 7 levels) with unique canonical reverse targets", () => {
		expect(PRIORITY_SURFACES).toEqual([
			"notion_personal",
			"notion_work",
			"work_mcp",
			"github_issue",
			"gmail_triage",
		]);
		expect(PRIORITY_SURFACE_MAPPINGS).toHaveLength(35);

		for (const surface of PRIORITY_SURFACES) {
			const rows = PRIORITY_SURFACE_MAPPINGS.filter(
				(m) => m.surface === surface,
			);
			expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 4, 5, 6, 7]);

			const distinctExternal = new Set(rows.map((r) => r.externalValue));
			for (const ext of distinctExternal) {
				const canonicalRows = rows.filter(
					(r) => r.externalValue === ext && r.isCanonicalReverse,
				);
				expect(canonicalRows).toHaveLength(1);
			}
		}
	});

	it("translates outbound and inbound priorities across all 5 surfaces", () => {
		// Personal Notion (3 Low, 2 Medium, 1 High; canonical reverse 2, 4, 6)
		expect(mapPriorityToSurface("notion_personal", 1)).toBe("3 Low");
		expect(mapPriorityToSurface("notion_personal", 2)).toBe("3 Low");
		expect(mapPriorityToSurface("notion_personal", 3)).toBe("2 Medium");
		expect(mapPriorityToSurface("notion_personal", 4)).toBe("2 Medium");
		expect(mapPriorityToSurface("notion_personal", 5)).toBe("1 High");
		expect(mapPriorityToSurface("notion_personal", 6)).toBe("1 High");
		expect(mapPriorityToSurface("notion_personal", 7)).toBe("1 High");
		expect(mapSurfaceToPriorityLevel("notion_personal", "3 Low")).toBe(2);
		expect(mapSurfaceToPriorityLevel("notion_personal", "2 Medium")).toBe(4);
		expect(mapSurfaceToPriorityLevel("notion_personal", "1 High")).toBe(6);

		// Work Notion (Low, Medium, High; canonical reverse 2, 4, 6)
		expect(mapPriorityToSurface("notion_work", 1)).toBe("Low");
		expect(mapPriorityToSurface("notion_work", 4)).toBe("Medium");
		expect(mapPriorityToSurface("notion_work", 5)).toBe("High");
		expect(mapPriorityToSurface("notion_work", 7)).toBe("High");
		expect(mapSurfaceToPriorityLevel("notion_work", "Low")).toBe(2);
		expect(mapSurfaceToPriorityLevel("notion_work", "Medium")).toBe(4);
		expect(mapSurfaceToPriorityLevel("notion_work", "High")).toBe(6);

		// work-mcp (1..2 -> 4_low [2], 3..4 -> 3_medium [4], 5 -> 2_high [5], 6..7 -> 1_critical [7])
		expect(mapPriorityToSurface("work_mcp", 1)).toBe("priority:4_low");
		expect(mapPriorityToSurface("work_mcp", 2)).toBe("priority:4_low");
		expect(mapPriorityToSurface("work_mcp", 3)).toBe("priority:3_medium");
		expect(mapPriorityToSurface("work_mcp", 4)).toBe("priority:3_medium");
		expect(mapPriorityToSurface("work_mcp", 5)).toBe("priority:2_high");
		expect(mapPriorityToSurface("work_mcp", 6)).toBe("priority:1_critical");
		expect(mapPriorityToSurface("work_mcp", 7)).toBe("priority:1_critical");
		expect(mapSurfaceToPriorityLevel("work_mcp", "priority:4_low")).toBe(2);
		expect(mapSurfaceToPriorityLevel("work_mcp", "priority:3_medium")).toBe(4);
		expect(mapSurfaceToPriorityLevel("work_mcp", "priority:2_high")).toBe(5);
		expect(mapSurfaceToPriorityLevel("work_mcp", "priority:1_critical")).toBe(7);

		// GitHub Issues (ADR-080; canonical reverse 2, 4, 6)
		expect(mapPriorityToSurface("github_issue", 1)).toBe("priority:low");
		expect(mapPriorityToSurface("github_issue", 3)).toBe("priority:medium");
		expect(mapPriorityToSurface("github_issue", 5)).toBe("priority:high");
		expect(mapPriorityToSurface("github_issue", 7)).toBe("priority:high");
		expect(mapSurfaceToPriorityLevel("github_issue", "priority:low")).toBe(2);
		expect(mapSurfaceToPriorityLevel("github_issue", "priority:medium")).toBe(4);
		expect(mapSurfaceToPriorityLevel("github_issue", "priority:high")).toBe(6);

		// Gmail triage ('1'..'7' 1:1)
		for (const level of PRIORITY_LEVEL_NUMBERS) {
			const ext = mapPriorityToSurface("gmail_triage", level);
			expect(ext).toBe(String(level));
			expect(mapSurfaceToPriorityLevel("gmail_triage", ext)).toBe(level);
			expect(toExternalPriority("gmail_triage", level)).toBe(String(level));
			expect(fromExternalPriority("gmail_triage", ext)).toBe(level);
		}
	});

	it("resolves effective priority_level with precedence: priority_level > priority_tier > priority", () => {
		expect(
			resolveEffectivePriorityLevel({
				priority_level: 7,
				priority_tier: "P2",
				priority: "low",
			}),
		).toBe(7);
		expect(
			resolveEffectivePriorityLevel({
				priority_tier: "P6",
				priority: "low",
			}),
		).toBe(6);
		expect(
			resolveEffectivePriorityLevel({
				priority_tier: 1,
			}),
		).toBe(6);
		expect(
			resolveEffectivePriorityLevel({
				priority_tier: 2,
			}),
		).toBe(4);
		expect(
			resolveEffectivePriorityLevel({
				priority_tier: "3",
			}),
		).toBe(2);
		expect(
			resolveEffectivePriorityLevel({
				priority: "1 High",
			}),
		).toBe(6);
		expect(
			resolveEffectivePriorityLevel({
				priority: "High",
			}),
		).toBe(5);
		expect(
			resolveEffectivePriorityLevel({
				priority: "urgent",
			}),
		).toBe(6);
		expect(resolveEffectivePriorityLevel({})).toBeUndefined();
	});
});

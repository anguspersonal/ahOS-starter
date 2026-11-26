import { describe, expect, it } from "vitest";
import { reconcileDomain } from "../../domain/domains.js";
import {
	CLOSED_STATUS_NAMES,
	extractNotionPageId,
	isOpenStatus,
	resolveClosedStatusNames,
	skippedDuplicateText,
	tomorrowDateOnly,
} from "./createTaskRules.js";

describe("createTaskRules", () => {
	it("computes tomorrowDateOnly across year boundaries", () => {
		expect(tomorrowDateOnly(new Date(2026, 11, 31, 23, 0))).toBe("2027-01-01");
	});

	it("formats skippedDuplicateText for singleTask and raceLost", () => {
		expect(
			skippedDuplicateText({
				artifactId: "a1",
				singleTask: true,
			}),
		).toContain("skipped as duplicate (single_task)");
		expect(
			skippedDuplicateText({
				artifactId: "a1",
				singleTask: false,
				raceLost: true,
			}),
		).toContain("lost a concurrent dedup race");
	});

	it("handles isOpenStatus and resolveClosedStatusNames", () => {
		expect(isOpenStatus("Done")).toBe(false);
		expect(isOpenStatus(" completed ")).toBe(false);
		for (const s of CLOSED_STATUS_NAMES) expect(isOpenStatus(s)).toBe(false);
		expect(isOpenStatus("In Progress")).toBe(true);
		expect(isOpenStatus(undefined)).toBe(true);

		const names = resolveClosedStatusNames(
			{ automations: { completed_at_stamp: { data_source_id: "ds1", status_property: "Status", done_values: ["Shipped"] } } },
			"ds1",
			"Status",
		);
		expect(isOpenStatus("shipped", names)).toBe(false);
		expect(isOpenStatus("Done", names)).toBe(false);
	});

	it("extracts Notion page ID from properties or source_url", () => {
		expect(extractNotionPageId({ properties: { notion_page_id: "pid1" } })).toBe("pid1");
		expect(extractNotionPageId({ properties: { notion_id: "pid2" } })).toBe("pid2");
		expect(extractNotionPageId({ source_url: "https://notion.so/12345678-1234-1234-1234-1234567890ab" })).toBe(
			"123456781234123412341234567890ab",
		);
		expect(extractNotionPageId({})).toBeNull();
	});

	it("rejects mismatched domain and workspace in reconcileDomain", () => {
		expect(() => reconcileDomain("work", "notion_personal", "workspace")).toThrow(
			"`domain: 'work'` and `workspace: 'notion_personal'` name different domains",
		);
	});
});

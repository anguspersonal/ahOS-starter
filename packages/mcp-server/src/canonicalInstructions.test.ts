import { describe, expect, it } from "vitest";
import {
	buildCanonicalInstructions,
	getCanonicalInstructionsHash,
	checkInstructionsFreshness,
	formatAge,
	renderToolTable,
	cleanToolDescription,
} from "./canonicalInstructions.js";
import { TOOL_ALIASES } from "./toolAliases.js";

describe("canonicalInstructions", () => {
	it("first line is the capability fallback (issue #1025 grill requirement)", () => {
		const text = buildCanonicalInstructions([]);
		const firstLine = text.split("\n")[0];
		expect(firstLine).toMatch(/^If you do not know a command, skill, or agent the user invokes, check ahOS for capabilities/);
	});

	it("contains zero em-dashes anywhere in the output (repo rule)", () => {
		const text = buildCanonicalInstructions([
			{ name: "capture", description: "Dump a note — stores an artifact — with tags" },
			{ name: "search", description: "Search the knowledge store — fast" },
		]);
		expect(text).not.toContain("\u2014");
	});

	it("uses correct names: ahkms, dos, dos_config_get", () => {
		const text = buildCanonicalInstructions([]);
		expect(text).toContain("connector name is ahkms");
		expect(text).toContain("Daily ritual: dos");
		expect(text).not.toContain("dos-hl");
		expect(text).toContain("dos_config_get");
		expect(text).not.toContain("get_dos_hl_config");
		expect(text).not.toContain("connector name: ahkms-knowledge");
		expect(text).toContain("Registry-Native by default");
		expect(text).toContain('capability_get({ name: "writing-for-agents" })');
		expect(text).toContain('capability_get({ name: "which-skill" })');
		expect(text).not.toContain("\u2014");
	});

	it("lists read and query routes", () => {
		const text = buildCanonicalInstructions([]);
		expect(text).toContain("gmail_search");
		expect(text).toContain("calendar_list_events");
		expect(text).toContain("drive_list");
		expect(text).toContain("notion_search");
		expect(text).toContain("dex_search_contacts");
		expect(text).toContain("posthog_query");
		expect(text).toContain("planning_read");
		expect(text).toContain("knowledge_search");
		expect(text).toContain("capability_get");
	});

	it("generates markdown table from registered tools", () => {
		const tools = [
			{ name: "capture", description: "Dump a note/content into the knowledge store. Creates artifact." },
			{ name: "knowledge_search", description: "Search the knowledge store. Fused ranking." },
			{ name: "search_knowledge", description: "Deprecated alias" },
		];
		const table = renderToolTable(tools);
		expect(table).toContain("| Tool | Description |");
		expect(table).toContain("| capture | Dump a note/content into the knowledge store. |");
		expect(table).toContain("| knowledge_search | Search the knowledge store. |");
		// search_knowledge is in TOOL_ALIASES so it must be filtered out
		expect(table).not.toContain("| search_knowledge |");
	});

	it("cleanToolDescription strips em-dashes and extracts first sentence", () => {
		const cleaned = cleanToolDescription("First sentence here. Second sentence — with em-dash.");
		expect(cleaned).toBe("First sentence here.");
		expect(cleaned).not.toContain("\u2014");
	});

	it("formatAge formats relative time accurately", () => {
		const now = new Date("2026-09-26T12:00:00Z");
		expect(formatAge("2026-09-26T08:00:00Z", now)).toBe("today");
		expect(formatAge("2026-09-25T12:00:00Z", now)).toBe("yesterday");
		expect(formatAge("2026-09-22T12:00:00Z", now)).toBe("4 days ago");
		expect(formatAge("2026-09-19T12:00:00Z", now)).toBe("1 week ago");
		expect(formatAge("2026-09-12T12:00:00Z", now)).toBe("2 weeks ago");
		expect(formatAge("2026-08-29T12:00:00Z", now)).toBe("4 weeks ago");
	});

	it("getCanonicalInstructionsHash produces 64-character sha256", () => {
		const hash = getCanonicalInstructionsHash([]);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("checkInstructionsFreshness computes status and detail", () => {
		const canonical = getCanonicalInstructionsHash([]);
		const now = new Date("2026-09-26T12:00:00Z");

		// Never pasted
		const unpasted = checkInstructionsFreshness(null, null, now, canonical);
		expect(unpasted.status).toBe("warn");
		expect(unpasted.isDrifted).toBe(true);
		expect(unpasted.detail).toContain("never recorded as pasted");
		expect(unpasted.fix).toContain("instructions_mark_pasted");

		// In sync
		const synced = checkInstructionsFreshness(canonical, "2026-09-25T12:00:00Z", now, canonical);
		expect(synced.status).toBe("ok");
		expect(synced.isDrifted).toBe(false);
		expect(synced.detail).toContain("up-to-date");

		// Drifted 2 weeks ago
		const drifted = checkInstructionsFreshness("c".repeat(64), "2026-09-12T12:00:00Z", now, canonical);
		expect(drifted.status).toBe("warn");
		expect(drifted.isDrifted).toBe(true);
		expect(drifted.detail).toBe(
			`pasted copy is behind, last pasted 2 weeks ago (pasted: cccccccc, canonical: ${canonical.slice(0, 8)})`,
		);
	});

	it("contains no retired tool name from TOOL_ALIASES", () => {
		const text = buildCanonicalInstructions([]);
		const retiredNames = Object.keys(TOOL_ALIASES).filter((name) => name.includes("_"));
		const found = retiredNames.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
		expect(found).toEqual([]);
	});
});

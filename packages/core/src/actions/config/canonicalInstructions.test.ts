import { describe, expect, it } from "vitest";
import {
	buildCanonicalInstructions,
	canonicalize,
	checkInstructionsFreshness,
	cleanToolDescription,
	DEPRECATED_TOOL_ALIAS_NAMES,
	extractSystemInstructionsSync,
	formatAge,
	getCanonicalInstructionsHash,
	hashBody,
	renderToolTable,
} from "./canonicalInstructions.js";

describe("canonicalInstructions (core, #1601)", () => {
	it("first line is the capability fallback (issue #1025 grill requirement)", () => {
		const text = buildCanonicalInstructions([]);
		const firstLine = text.split("\n")[0];
		expect(firstLine).toMatch(
			/^If you do not know a command, skill, or agent the user invokes, check ahOS for capabilities/,
		);
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

	it("generates markdown table from registered tools and filters deprecated aliases", () => {
		const tools = [
			{
				name: "capture",
				description: "Dump a note/content into the knowledge store. Creates artifact.",
			},
			{ name: "knowledge_search", description: "Search the knowledge store. Fused ranking." },
			{ name: "search_knowledge", description: "Deprecated alias" },
		];
		const table = renderToolTable(tools);
		expect(table).toContain("| Tool | Description |");
		expect(table).toContain("| capture | Dump a note/content into the knowledge store. |");
		expect(table).toContain("| knowledge_search | Search the knowledge store. |");
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

	it("getCanonicalInstructionsHash and hashBody produce 64-character sha256", () => {
		expect(canonicalize("hello  \r\nworld\t\n\n")).toBe("hello\nworld\n");
		expect(hashBody("hello  \r\nworld\t\n\n")).toBe(
			"4a1e67f2fe1d1cc7b31d0ca2ec441da4778203a036a77da10344c85e24ff0f92",
		);
		const hash = getCanonicalInstructionsHash([]);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("checkInstructionsFreshness computes status and detail", () => {
		const canonical = getCanonicalInstructionsHash([]);
		const now = new Date("2026-09-26T12:00:00Z");

		const unpasted = checkInstructionsFreshness(null, null, now, canonical);
		expect(unpasted.status).toBe("warn");
		expect(unpasted.isDrifted).toBe(true);
		expect(unpasted.detail).toContain("never recorded as pasted");
		expect(unpasted.fix).toContain("instructions_mark_pasted");

		const synced = checkInstructionsFreshness(canonical, "2026-09-25T12:00:00Z", now, canonical);
		expect(synced.status).toBe("ok");
		expect(synced.isDrifted).toBe(false);
		expect(synced.detail).toContain("up-to-date");

		const drifted = checkInstructionsFreshness(
			"c".repeat(64),
			"2026-09-12T12:00:00Z",
			now,
			canonical,
		);
		expect(drifted.status).toBe("warn");
		expect(drifted.isDrifted).toBe(true);
		expect(drifted.detail).toBe(
			`pasted copy is behind, last pasted 2 weeks ago (pasted: cccccccc, canonical: ${canonical.slice(0, 8)})`,
		);
	});

	it("extractSystemInstructionsSync reads system_instructions_sync and falls back to legacy keys", () => {
		const primary = { sha256: "1".repeat(64), pasted_at: "2026-10-30T10:00:00Z" };
		const legacy = { sha256: "2".repeat(64), pasted_at: "2026-10-29T10:00:00Z" };

		expect(
			extractSystemInstructionsSync({
				system_instructions_sync: primary,
				claude_instructions_sync: legacy,
			}),
		).toEqual(primary);

		expect(
			extractSystemInstructionsSync({
				claude_instructions_sync: legacy,
			}),
		).toEqual(legacy);
	});

	it("contains no retired tool name from DEPRECATED_TOOL_ALIAS_NAMES", () => {
		const text = buildCanonicalInstructions([]);
		const retiredNames = [...DEPRECATED_TOOL_ALIAS_NAMES].filter((name) => name.includes("_"));
		const found = retiredNames.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
		expect(found).toEqual([]);
	});

	it("names all six drive_comment_* tools and keeps docs_comments on the Google Drive and Docs line (#2390)", () => {
		const text = buildCanonicalInstructions([]);
		const line = text
			.split("\n")
			.find((entry) => entry.startsWith("- Google Drive and Docs:"));
		expect(line).toBeDefined();
		const items = line!
			.slice("- Google Drive and Docs:".length)
			.split(",")
			.map((item) => item.trim());
		for (const tool of [
			"drive_comment_list",
			"drive_comment_get",
			"drive_comment_create",
			"drive_comment_reply",
			"drive_comment_update",
			"drive_comment_delete",
			"docs_comments",
		]) {
			expect(items).toContain(tool);
		}
		expect(text).not.toContain("\u2014");
	});
});

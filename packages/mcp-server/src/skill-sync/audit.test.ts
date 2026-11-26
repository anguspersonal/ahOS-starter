import { describe, expect, it } from "vitest";
import type { AhkmsCapability } from "./ahkmsSource.js";
import { buildAudit, classifyBodyGap, formatAudit } from "./audit.js";

// The audit's value is the SPLIT, not the count (#689): a kms-hosted row with no
// body is a defect (the registry promises to serve bytes it does not have), while
// an externally-owned index entry with no body is the designed state. Reporting
// them as one list would bury eight real bugs under thirty non-bugs.

function cap(overrides: Partial<AhkmsCapability> & { name: string }): AhkmsCapability {
	return {
		kind: "skill",
		storageLocation: "kms-db",
		storageUrl: null,
		surface: ["claude-code"],
		body: "body",
		bodySyncedAt: null,
		...overrides,
	};
}

describe("classifyBodyGap", () => {
	it.each([
		["kms-db", "broken"],
		["kms-repo", "broken"],
		["claude", "pointer"],
		["openai", "pointer"],
	])("classifies %s as %s", (storage, expected) => {
		expect(classifyBodyGap(storage)).toBe(expected);
	});
});

describe("buildAudit", () => {
	it("separates hosted-but-empty rows from externally-owned pointers", () => {
		const report = buildAudit([
			cap({ name: "with-body" }),
			cap({ name: "dos-hl", storageLocation: "kms-repo", storageUrl: ".claude/skills/dos-hl", body: null }),
			cap({ name: "handoff", storageLocation: "claude", storageUrl: "~/.claude/skills/handoff", body: null }),
		]);

		expect(report.totalCapabilities).toBe(3);
		expect(report.withBody).toBe(1);
		expect(report.rows.map((row) => [row.name, row.gap])).toEqual([
			["dos-hl", "broken"],
			["handoff", "pointer"],
		]);
	});

	it("treats a whitespace-only body as no body — it serves nothing followable", () => {
		expect(buildAudit([cap({ name: "hollow", body: "   \n" })]).rows[0].gap).toBe("broken");
	});

	it("puts broken rows first, then sorts each group by name", () => {
		const report = buildAudit([
			cap({ name: "zeta", storageLocation: "claude", body: null }),
			cap({ name: "beta", storageLocation: "kms-db", body: null }),
			cap({ name: "alpha", storageLocation: "claude", body: null }),
		]);
		expect(report.rows.map((row) => row.name)).toEqual(["beta", "alpha", "zeta"]);
	});
});

describe("formatAudit", () => {
	it("says so explicitly when nothing is broken, rather than printing an empty heading", () => {
		const text = formatAudit(buildAudit([cap({ name: "ok" })]));
		expect(text).toContain("(none — every kms-hosted capability serves a body)");
	});

	it("names the #689 failure beside the broken rows", () => {
		const text = formatAudit(buildAudit([cap({ name: "dos-hl", storageLocation: "kms-repo", body: null })]));
		expect(text).toContain("dos-hl");
		expect(text).toContain("improvises from the description");
	});
});

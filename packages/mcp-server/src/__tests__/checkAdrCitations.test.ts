/**
 * Unit tests for the apex-doc citation guard (#849, ADR-056).
 *
 * The script is plain CommonJS at the repo root (matches its siblings, e.g.
 * scripts/check-skill-bodies.js), so it is loaded via createRequire. Every test
 * but the last two drives the pure core with synthetic inputs.
 *
 * Four load-bearing pins:
 *   1. An unacknowledged citation of a superseded ADR must FAIL. That is the
 *      whole reason the guard exists; a guard that cannot fail reports success
 *      for behaviour it never checked.
 *   2. "Superseded IN PLACE" must NOT fail. ADR-039 §1 lets an ADR amend
 *      itself, and ADR-052 §5 and ADR-054 §8 both did. Those Status lines say
 *      "superseded" and name no successor, so there is nothing a citing
 *      document could acknowledge. The first draft of this guard flagged them
 *      and printed "superseded by " with an empty successor — a rule the prose
 *      cannot satisfy, which is a broken guard rather than a strict one.
 *   3. Acknowledgement must be WINDOWED. If any mention of the successor
 *      anywhere in the file counted, a doc that discusses ADR-051 in one
 *      section would be licensed to make stale ADR-023 claims in every other.
 *   4. The REAL committed docs/architecture/architecture.md must pass — it
 *      already acknowledges its superseded citations at :147, so the rule this
 *      guard enforces is the convention the repo already writes in, not one
 *      invented here.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { analyze, findCitations, isAcknowledged, parseStatus, readAdrStatuses, readDocs, ACK_WINDOW } = require("../../../../scripts/check-adr-citations.js");

const FULL = "- **Status:** Superseded by [ADR-051](./ADR051_One_EOD_Ritual.md)";
const PARTIAL = "- **Status:** Accepted · Superseded in part by [ADR-050](./ADR050_One_Ritual.md)";
const IN_PLACE = "- **Status:** Proposed — §8's conclusion **superseded in place** 2026-08-22 (`dos-catchup` retires)";
const PLAIN = "- **Status:** Accepted";

describe("parseStatus", () => {
	it("reads a full supersession and its successor", () => {
		expect(parseStatus(FULL)).toEqual({ superseded: "full", supersededBy: ["ADR-051"] });
	});

	it("reads a partial supersession and its successor", () => {
		expect(parseStatus(PARTIAL)).toEqual({ superseded: "partial", supersededBy: ["ADR-050"] });
	});

	it("dedupes the successor named twice — as link text and inside the link path", () => {
		expect(parseStatus(FULL).supersededBy).toHaveLength(1);
	});

	// Pin 2. The regression that shipped in the first draft.
	it("does NOT treat 'superseded in place' as a supersession — no successor is named", () => {
		expect(parseStatus(IN_PLACE)).toEqual({ superseded: null, supersededBy: [] });
	});

	it("drops a self-reference, which would otherwise be unacknowledgeable", () => {
		const selfOnly = "- **Status:** Accepted — [ADR-054](./ADR054_X.md) §8 superseded in place";
		expect(parseStatus(selfOnly, "ADR-054")).toEqual({ superseded: null, supersededBy: [] });
	});

	it("treats a plain or missing status as not superseded", () => {
		expect(parseStatus(PLAIN).superseded).toBeNull();
		expect(parseStatus(null).superseded).toBeNull();
	});
});

describe("findCitations", () => {
	it("finds both citation forms and normalises them to one id", () => {
		const text = "prose cites ADR-023.\na link to [x](./ADR023_Sibling.md) too.";
		expect(findCitations(text)).toEqual([
			{ id: "ADR-023", line: 1 },
			{ id: "ADR-023", line: 2 },
		]);
	});

	// #850. The watermark names the ADR a review reached, not a claim resting on its
	// content, so it must not be dragged along when that ADR is later superseded.
	it("ignores the #850 watermark line, which names ADRs without citing them", () => {
		const text = "**Reviewed-against:** ADR-023 · 2026-08-24 · evidence: ADR-057\nprose cites ADR-018.";
		expect(findCitations(text)).toEqual([{ id: "ADR-018", line: 2 }]);
	});
});

describe("isAcknowledged", () => {
	// Pin 3.
	it("accepts the successor at the window edge and rejects it beyond", () => {
		// n fillers between the two lines puts them n+1 apart, so the last
		// accepted gap is ACK_WINDOW - 1 fillers.
		const atEdge = ["ADR-051", ...Array(ACK_WINDOW - 1).fill("filler"), "cites ADR-023"];
		expect(isAcknowledged(atEdge, atEdge.length, ["ADR-051"])).toBe(true);

		const beyond = ["ADR-051", ...Array(ACK_WINDOW).fill("filler"), "cites ADR-023"];
		expect(isAcknowledged(beyond, beyond.length, ["ADR-051"])).toBe(false);
	});

	it("accepts the unhyphenated link form as acknowledgement", () => {
		const lines = ["cites ADR-023, replaced by [it](./ADR051_One_EOD.md)"];
		expect(isAcknowledged(lines, 1, ["ADR-051"])).toBe(true);
	});
});

describe("analyze", () => {
	const statuses = { "ADR-023": FULL, "ADR-018": PARTIAL, "ADR-054": IN_PLACE, "ADR-021": PLAIN };

	// Pin 1. The guard must be able to fail.
	it("flags an unacknowledged citation of a superseded ADR", () => {
		const docs = { "docs/vision.md": "The consumers come from ADR-023.\n" };
		expect(analyze(docs, statuses)).toEqual([
			{ doc: "docs/vision.md", line: 1, cited: "ADR-023", severity: "full", supersededBy: ["ADR-051"] },
		]);
	});

	it("passes a citation that names its successor nearby", () => {
		const docs = { "docs/vision.md": "From ADR-023, superseded by ADR-051.\n" };
		expect(analyze(docs, statuses)).toEqual([]);
	});

	it("flags a partial supersession too, marked as such", () => {
		const docs = { "docs/vision.md": "Interpretation moved to read time (ADR-018).\n" };
		expect(analyze(docs, statuses)[0]).toMatchObject({ cited: "ADR-018", severity: "partial" });
	});

	// Pin 2, at the level the guard actually runs.
	it("never flags an in-place supersession", () => {
		const docs = { "docs/vision.md": "The config is settled by ADR-054.\n" };
		expect(analyze(docs, statuses)).toEqual([]);
	});

	it("ignores a citation of an ADR absent from this tree — the link guard owns that", () => {
		const docs = { "docs/vision.md": "See ADR-999.\n" };
		expect(analyze(docs, statuses)).toEqual([]);
	});

	it("ignores a citation of a live ADR", () => {
		const docs = { "docs/vision.md": "Vocabulary is ADR-021.\n" };
		expect(analyze(docs, statuses)).toEqual([]);
	});
});

describe("the real committed tree", () => {
	// Pin 4.
	it("parses every real ADR status without throwing, and finds real supersessions", () => {
		const statuses = readAdrStatuses();
		expect(Object.keys(statuses).length).toBeGreaterThan(50);
		expect(parseStatus(statuses["ADR-023"], "ADR-023")).toEqual({
			superseded: "full",
			supersededBy: ["ADR-051"],
		});
	});

	it("passes docs/architecture/architecture.md, which already acknowledges its superseded citations", () => {
		const docs = readDocs();
		const arch = { "docs/architecture/architecture.md": docs["docs/architecture/architecture.md"] };
		expect(analyze(arch, readAdrStatuses())).toEqual([]);
	});
});

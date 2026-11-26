import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_BASELINE_PATH, parseLegacyBaseline, readLegacyBaseline } from "./legacyBaseline.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_READERS = new Set(["legacyBaseline.ts", "surfaceRegistry.test.ts"]);
// A quoted string holding a directory path that ends in the baseline file name.
// Test titles name the file without a directory, so they do not match. Quote characters are
// written as \x22 \x27 \x60 so scripts/check-turbo-inputs.js can track brace depth in this file.
const BASELINE_PATH_LITERAL = new RegExp(
	"[\\x22\\x27\\x60][^\\x22\\x27\\x60\\n]*/legacy-tools-baseline\\.txt[\\x22\\x27\\x60]",
);

function listTestSources(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return listTestSources(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

describe("legacy-tools-baseline.txt reader (#2338)", () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("Case 1: parseLegacyBaseline returns the trimmed, non-empty, non-comment lines, sorted", () => {
		const text = "# header\n#  another comment\n\n  zeta_tool  \r\nalpha_tool\n   \n\tmid_tool\n";
		expect(parseLegacyBaseline(text)).toEqual(["alpha_tool", "mid_tool", "zeta_tool"]);
		expect(parseLegacyBaseline("# header only\n")).toEqual([]);
		expect(parseLegacyBaseline("")).toEqual([]);
	});

	it("Case 2: readLegacyBaseline returns [] for an absent path and the parsed entries for a file that exists", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-baseline-"));
		tmpDirs.push(dir);
		const file = path.join(dir, "legacy-tools-baseline.txt");

		expect(readLegacyBaseline(file)).toEqual([]);

		fs.writeFileSync(file, "# Legacy MCP tools\nsecond_tool\nfirst_tool\n");
		expect(readLegacyBaseline(file)).toEqual(["first_tool", "second_tool"]);
	});

	it("Case 3: readLegacyBaseline() with no argument reads the mcp-server package's legacy-tools-baseline.txt", () => {
		expect(LEGACY_BASELINE_PATH).toBe(path.resolve(TESTS_DIR, "../..", "legacy-tools-baseline.txt"));
		const entries = readLegacyBaseline();
		expect(entries).toEqual(readLegacyBaseline(LEGACY_BASELINE_PATH));
		// The two tools left on 21 Nov 2026; the list may only shrink (#1338).
		for (const entry of entries) {
			expect(["gmail_reconcile", "ingest_enrich_next"]).toContain(entry);
		}
		expect(entries).toEqual([...entries].sort());
	});

	it("Case 4: no test file other than legacyBaseline.ts and surfaceRegistry.test.ts reads the baseline by path", () => {
		const offenders = listTestSources(TESTS_DIR)
			.filter((file) => !ALLOWED_READERS.has(path.basename(file)))
			.filter((file) => BASELINE_PATH_LITERAL.test(fs.readFileSync(file, "utf8")))
			.map((file) => path.relative(TESTS_DIR, file))
			.sort();
		expect(
			offenders,
			`Read legacy-tools-baseline.txt through readLegacyBaseline() from ./legacyBaseline.js, not readFileSync: ${offenders.join(", ")}`,
		).toEqual([]);
	});
});

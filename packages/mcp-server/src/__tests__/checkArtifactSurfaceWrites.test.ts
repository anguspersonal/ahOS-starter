/**
 * Unit tests for the artifact-surface write guard (#570 AC4 / ADR-046 §2/§3).
 *
 * The script is plain CommonJS at the repo root (matches sibling repo-wide
 * checks, e.g. scripts/check-user-id-reads.js), so it is loaded via
 * createRequire. Every test is pure static analysis of synthetic sources — no
 * database involved — except the last, which replays the guard over the REAL
 * committed packages/ tree and must pass (the same bar CI runs).
 *
 * The load-bearing pair: a synthetic NEW ingest path that inserts artifacts
 * without declaring itself must FAIL, and the discover path losing its
 * `surface` stamp must FAIL. Those two are the whole reason the guard exists —
 * a guard that cannot fail is worse than none, because it reports success for
 * behaviour it never checked.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	isTestPath,
	findWriteSites,
	buildResult,
	formatReport,
	readPackageFiles,
	ARTIFACT_WRITE_SITES,
	PACKAGES_DIR,
} = require("../../../../scripts/check-artifact-surface-writes.js");

const DISCOVER_PATH = "packages/mcp-server/src/tools/discover.ts";

// A minimal stand-in for the real discover.ts: one artifacts insert, and the
// two `surface: channel` stamps (insert payload + changed-content update).
const DISCOVER_OK = [
	"const insertRow = {",
	"\tsource_channel: channel,",
	"\tsurface: channel,",
	"};",
	"const updatePayload = {",
	"\tsurface: channel,",
	"};",
	'await supabase.from("artifacts").insert(toInsert);',
	"",
].join("\n");

describe("isTestPath", () => {
	it("treats __tests__, /tests/ and .test/.spec files as tests", () => {
		expect(isTestPath("packages/mcp-server/src/__tests__/capture.test.ts")).toBe(true);
		expect(isTestPath("packages/web/tests/integration/helpers/test-helpers.ts")).toBe(true);
		expect(isTestPath("packages/worker/src/foo.spec.ts")).toBe(true);
	});

	it("does not treat production files as tests", () => {
		expect(isTestPath(DISCOVER_PATH)).toBe(false);
		expect(isTestPath("packages/worker/src/workflows/steps/createArtifact.ts")).toBe(false);
	});
});

describe("findWriteSites", () => {
	it("finds a single-line insert chain", () => {
		expect(findWriteSites('await supabase.from("artifacts").insert(rows);')).toHaveLength(1);
	});

	it("finds a multi-line chain and reports its line", () => {
		const hits = findWriteSites('a\nb\nconst q = supabase\n\t.from("artifacts")\n\t.insert({});');
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(4);
	});

	it("finds upserts too", () => {
		expect(findWriteSites(".from('artifacts').upsert(row)")).toHaveLength(1);
	});

	it("ignores reads and updates on the same table", () => {
		expect(findWriteSites('supabase.from("artifacts").select("id")')).toHaveLength(0);
		expect(findWriteSites('supabase.from("artifacts").update({ x: 1 })')).toHaveLength(0);
		expect(findWriteSites('supabase.from("artifacts").delete()')).toHaveLength(0);
	});

	it("ignores inserts into other tables", () => {
		expect(findWriteSites('supabase.from("entities").insert(row)')).toHaveLength(0);
		expect(findWriteSites('supabase.from("artifact_entity_links").insert(row)')).toHaveLength(0);
	});
});

describe("buildResult", () => {
	it("FAILS on a new undeclared ingest path — the #570 recurrence scenario", () => {
		// A future connector copies drive/shared.ts's insert shape and ships.
		const result = buildResult([
			{
				relPath: "packages/mcp-server/src/tools/newConnector.ts",
				source: 'await supabase.from("artifacts").insert({ source_channel: "newthing" });',
			},
		]);
		expect(result.ok).toBe(false);
		expect(
			result.violations.some(
				(v: { kind: string; file: string }) =>
					v.kind === "undeclared-write-path" &&
					v.file === "packages/mcp-server/src/tools/newConnector.ts",
			),
		).toBe(true);
	});

	it("FAILS when the discover path loses its surface stamp", () => {
		const stripped = DISCOVER_OK.replace(/^\tsurface: channel,$/gm, "");
		const result = buildResult([{ relPath: DISCOVER_PATH, source: stripped }]);
		expect(
			result.violations.some(
				(v: { kind: string; file: string }) =>
					v.kind === "missing-surface-stamp" && v.file === DISCOVER_PATH,
			),
		).toBe(true);
	});

	it("FAILS when only ONE of the discover path's two stamps survives", () => {
		// The update-payload stamp deleted: new rows are fine, changed rows regress.
		const halfStripped = DISCOVER_OK.replace("const updatePayload = {\n\tsurface: channel,\n};", "");
		const result = buildResult([{ relPath: DISCOVER_PATH, source: halfStripped }]);
		expect(
			result.violations.some((v: { kind: string }) => v.kind === "missing-surface-stamp"),
		).toBe(true);
	});

	it("accepts the discover path with both stamps in place", () => {
		const result = buildResult([{ relPath: DISCOVER_PATH, source: DISCOVER_OK }]);
		expect(
			result.violations.some(
				(v: { kind: string; file: string }) => v.file === DISCOVER_PATH && v.kind !== "stale-registry-entry",
			),
		).toBe(false);
	});

	it("FAILS when a new insert is added to an already-declared file", () => {
		const result = buildResult([
			{ relPath: DISCOVER_PATH, source: `${DISCOVER_OK}\nsupabase.from("artifacts").insert(more);` },
		]);
		expect(
			result.violations.some((v: { kind: string }) => v.kind === "site-count-changed"),
		).toBe(true);
	});

	it("FAILS on a stale registry entry whose write site is gone", () => {
		// Nothing supplied, so every declared path is missing.
		const result = buildResult([]);
		expect(
			result.violations.every((v: { kind: string }) => v.kind === "stale-registry-entry"),
		).toBe(true);
		expect(result.violations).toHaveLength(Object.keys(ARTIFACT_WRITE_SITES).length);
	});

	it("ignores write sites in test files", () => {
		const result = buildResult([
			{
				relPath: "packages/mcp-server/src/__tests__/fixture.test.ts",
				source: 'supabase.from("artifacts").insert({});',
			},
		]);
		expect(
			result.violations.some((v: { kind: string }) => v.kind === "undeclared-write-path"),
		).toBe(false);
	});
});

/**
 * The six paths #584 and #736 closed. Each entry is a minimal stand-in for the real
 * file — one artifacts insert plus the exact line the registry pins — and each is
 * exercised twice: intact (must pass) and with the stamp deleted (must fail). A pin
 * nobody has watched fail is a pin nobody knows works, and these six are the whole of
 * the write-side fix (five from #584, createTask.ts from #736), so an unverified pin
 * here would silently un-do it.
 */
const CLOSED_PATHS: Array<{ file: string; ok: string; strip: (s: string) => string }> = [
	{
		file: "packages/core/src/actions/artifacts/captureBody.ts",
		ok: [
			"await deps.artifacts.insert({",
			"\tsource_channel: routing.source_channel,",
			"\tsurface: args.surface ?? prefs.default_surface ?? ARTIFACT_SURFACES.api,",
			"});",
			"",
		].join("\n"),
		// The realistic regression is not deleting the line but dropping the FLOOR off
		// the end of the chain -- which restores the exact pre-#584 expression.
		strip: (s) =>
			s.replace(
				"surface: args.surface ?? prefs.default_surface ?? ARTIFACT_SURFACES.api,",
				"surface: args.surface ?? prefs.default_surface ?? null,",
			),
	},
	{
		file: "packages/core/src/actions/drive/importFile.ts",
		ok: [
			"await ports.artifacts.insert({",
			'\tsource_channel: "google_drive",',
			"\tsurface: ARTIFACT_SURFACES.driveImport,",
			"});",
			"",
		].join("\n"),
		strip: (s) => s.replace("\tsurface: ARTIFACT_SURFACES.driveImport,\n", ""),
	},
	{
		file: "packages/mcp-server/src/tools/drive/shared.ts",
		ok: [
			'await supabase.from("artifacts").insert({',
			'\tsource_channel: "google_drive",',
			"\tsurface: ARTIFACT_SURFACES.driveImport,",
			"});",
			"",
		].join("\n"),
		strip: (s) => s.replace("\tsurface: ARTIFACT_SURFACES.driveImport,\n", ""),
	},
	{
		file: "packages/core/src/actions/calendar/eventCreate.ts",
		ok: [
			"await ports.artifacts.insert({",
			"\tsurface: ARTIFACT_SURFACES.actReceipt,",
			"\tcontent_subtype: EVENT_REQUEST_CONTENT_SUBTYPE,",
			"});",
			"",
		].join("\n"),
		strip: (s) => s.replace("\tsurface: ARTIFACT_SURFACES.actReceipt,\n", ""),
	},
	{
		file: "packages/worker/src/workflows/steps/createArtifact.ts",
		ok: [
			"function resolveUploadSurface(platform) {",
			"\tswitch (platform) {",
			"\t\tdefault:",
			"\t\t\treturn ARTIFACT_SURFACES.api;",
			"\t}",
			"}",
			"const artifactData = {",
			"\tsurface: resolveUploadSurface(userContext.deviceInfo?.platform),",
			"};",
			"await supabase.from('artifacts').insert(artifactData);",
			"",
		].join("\n"),
		// Deleting the resolver's total default arm leaves the call site untouched, so
		// pinning only the call would still pass while the function had gone partial.
		strip: (s) => s.replace("\t\tdefault:\n\t\t\treturn ARTIFACT_SURFACES.api;\n", ""),
	},
	{
		file: "packages/worker/src/workflows/steps/createDerived.ts",
		ok: [
			"const artifactData = {",
			"\tsource_channel: 'derived',",
			"\tsurface: ARTIFACT_SURFACES.derived,",
			"};",
			"await supabase.from('artifacts').insert(artifactData);",
			"",
		].join("\n"),
		strip: (s) => s.replace("\tsurface: ARTIFACT_SURFACES.derived,\n", ""),
	},
	{
		file: "packages/core/src/actions/tasks/createTaskBody.ts",
		ok: [
			"await ports.artifacts.insert({",
			"\tsurface: ARTIFACT_SURFACES.actReceipt,",
			"\tcontent_subtype: TASK_REQUEST_CONTENT_SUBTYPE,",
			"});",
			"",
		].join("\n"),
		strip: (s) => s.replace("\tsurface: ARTIFACT_SURFACES.actReceipt,\n", ""),
	},
];

describe("the six write paths #584 and #736 closed", () => {
	for (const { file, ok, strip } of CLOSED_PATHS) {
		it(`accepts ${file} with its stamp intact`, () => {
			const result = buildResult([{ relPath: file, source: ok }]);
			expect(
				result.violations.filter(
					(v: { kind: string; file: string }) => v.file === file && v.kind !== "stale-registry-entry",
				),
			).toEqual([]);
		});

		it(`FAILS when ${file} loses its stamp`, () => {
			const stripped = strip(ok);
			expect(stripped, "the strip must actually change the source").not.toBe(ok);
			const result = buildResult([{ relPath: file, source: stripped }]);
			expect(
				result.violations.some(
					(v: { kind: string; file: string }) => v.kind === "missing-surface-stamp" && v.file === file,
				),
			).toBe(true);
		});
	}
});

describe("registry integrity", () => {
	it("declares zero remaining gaps now that createTask.ts is closed (#736)", () => {
		// The countdown to a NOT NULL constraint on artifacts.surface, from this
		// guard's vantage point. Reaching zero clears the in-repo precondition —
		// it does NOT by itself clear the constraint, since an external n8n writer
		// is outside what a static scan of packages/ can see (see formatReport's
		// zero-gap message below).
		const gaps = (
			Object.entries(ARTIFACT_WRITE_SITES) as [string, { stampsSurface: boolean }][]
		)
			.filter(([, d]) => !d.stampsSurface)
			.map(([file]) => file);
		expect(gaps).toEqual([]);
	});

	it("every path claiming to stamp surface actually pins it", () => {
		// A `stampsSurface: true` with no requiredPatterns is the guard's own failure
		// mode — an unchecked claim — relocated into its registry.
		for (const [file, entry] of Object.entries(ARTIFACT_WRITE_SITES) as [
			string,
			{ stampsSurface: boolean; requiredPatterns?: unknown[] },
		][]) {
			if (!entry.stampsSurface) continue;
			expect(entry.requiredPatterns?.length ?? 0, `${file} claims a stamp it does not pin`).toBeGreaterThan(0);
		}
	});

	it("FAILS a registry entry that claims a stamp without pinning it", () => {
		const stub = { sites: 1, stampsSurface: true, why: "unpinned on purpose" };
		const file = "packages/mcp-server/src/tools/unpinned.ts";
		ARTIFACT_WRITE_SITES[file] = stub;
		try {
			const result = buildResult([
				{ relPath: file, source: 'supabase.from("artifacts").insert({});' },
			]);
			expect(
				result.violations.some(
					(v: { kind: string; file: string }) => v.kind === "unpinned-surface-claim" && v.file === file,
				),
			).toBe(true);
		} finally {
			delete ARTIFACT_WRITE_SITES[file];
		}
	});


	it("declares the discover path as stamping surface, with a pinned pattern", () => {
		const entry = ARTIFACT_WRITE_SITES[DISCOVER_PATH];
		expect(entry.stampsSurface).toBe(true);
		expect(entry.requiredPatterns.length).toBeGreaterThan(0);
	});

	it("every known gap names the issue tracking it", () => {
		for (const [file, entry] of Object.entries(ARTIFACT_WRITE_SITES) as [
			string,
			{ stampsSurface: boolean; issue?: number; why: string },
		][]) {
			if (entry.stampsSurface) continue;
			expect(entry.issue, `${file} must name a tracking issue`).toBeTypeOf("number");
			expect(entry.why.length).toBeGreaterThan(0);
		}
	});
});

describe("formatReport", () => {
	it("names the offending file and the violation kind", () => {
		const result = buildResult([
			{
				relPath: "packages/mcp-server/src/tools/newConnector.ts",
				source: 'supabase.from("artifacts").insert({});',
			},
		]);
		const report = formatReport(result).join("\n");
		expect(report).toContain("FAIL");
		expect(report).toContain("undeclared-write-path");
		expect(report).toContain("newConnector.ts");
	});

	it("prints the remaining-gap count on a passing run, and names each gap", () => {
		// The count is the thing a human is meant to watch reach zero — it is the
		// precondition on constraining the column, so it has to be legible in the
		// PASSING output, not only in a failure (#584). Exercised against a
		// synthetic gap rather than the real tree: since #736, the real tree has
		// none — see "does NOT green-light..." below for that branch instead.
		const report = formatReport({
			ok: true,
			filesScanned: 375,
			sitesFound: 8,
			declaredPaths: 8,
			knownGaps: [{ file: "packages/mcp-server/src/tools/hypothetical.ts", issue: 999 }],
			violations: [],
		}).join("\n");
		expect(report).toContain("1 write path(s) can still produce a NULL surface");
		expect(report).toContain("packages/mcp-server/src/tools/hypothetical.ts (#999)");
		expect(report).toContain("cannot take a NOT NULL constraint");
	});

	it("does NOT green-light the constraint on the in-repo precondition alone", () => {
		// Since #736 closed the last in-repo gap (createTask.ts), this branch is
		// what a real run now hits — and it is also the piece that tells a human
		// it is safe to constrain a production column. The guard can only ever
		// prove the in-repo half: an external n8n workflow wrote artifacts rows
		// straight through PostgREST, and no static scan of TypeScript under
		// packages/ can see it. Saying "eligible" on the strength of the
		// measurable half is how the landmine gets armed (#736).
		const report = formatReport({
			ok: true,
			filesScanned: 375,
			sitesFound: 7,
			declaredPaths: 7,
			knownGaps: [],
			violations: [],
		}).join("\n");
		expect(report).toContain("No write path IN THIS REPO");
		expect(report).toContain("STILL UNVERIFIED");
		expect(report).toContain("n8n");
		expect(report).not.toContain("is now eligible");
	});
});

describe("real repository state", () => {
	it("the committed packages/ tree passes the guard", () => {
		// The same scan CI runs. If this fails, an artifacts write path was added
		// or changed without declaring what it does about `surface` (#570).
		const result = buildResult(readPackageFiles(PACKAGES_DIR));
		expect(result.violations).toEqual([]);
		expect(result.ok).toBe(true);
		// Sanity: the walk really visited the tree and found the known writers.
		expect(result.filesScanned).toBeGreaterThan(100);
		const expectedSites = (
			Object.values(ARTIFACT_WRITE_SITES) as Array<{ sites: number }>
		).reduce((sum, entry) => sum + entry.sites, 0);
		expect(result.sitesFound).toBe(expectedSites);
	});

	it("reports zero known gaps and the correct not-yet-eligible message (#736)", () => {
		// The in-repo half of the NOT NULL precondition: every write path this
		// guard can see now stamps a non-null surface. The report still must not
		// claim the constraint itself is safe to add — the external n8n writer is
		// outside this scan's reach (see formatReport's zero-gap branch).
		const result = buildResult(readPackageFiles(PACKAGES_DIR));
		expect(result.knownGaps).toEqual([]);
		const report = formatReport(result).join("\n");
		expect(report).toContain("No write path IN THIS REPO can produce a NULL surface");
		expect(report).toContain("STILL UNVERIFIED");
		expect(report).toContain("n8n");
	});
});

describe("ArtifactRepository write seam & cross-file / payload-only pins (#1611)", () => {
	const ADAPTER_PATH = "packages/core/src/adapters/supabase/artifacts.ts";
	const PORT_PATH = "packages/core/src/ports/artifacts.ts";

	it("FAILS with missing-surface-stamp when ArtifactInsertRow marks surface optional", () => {
		const result = buildResult([
			{
				relPath: ADAPTER_PATH,
				source: 'await options.client.from("artifacts").insert(row).select("id, title, created_at").single();',
			},
			{
				relPath: PORT_PATH,
				source: [
					"export type ArtifactInsertRow = {",
					"\tid: string;",
					"\tsurface?: string;",
					"};",
				].join("\n"),
			},
		]);
		expect(
			result.violations.some(
				(v: { kind: string; file: string }) =>
					v.kind === "missing-surface-stamp" && v.file === ADAPTER_PATH,
			),
		).toBe(true);
	});

	it("FAILS with missing-surface-stamp when a cross-file pin (pins: [{ file, label, pattern, min }]) no longer matches, including on a payload-only (sites: 0) entry", () => {
		const callerPath = "packages/core/src/actions/domain/syntheticCapture.ts";
		const helperPath = "packages/core/src/actions/domain/syntheticHelper.ts";
		ARTIFACT_WRITE_SITES[callerPath] = {
			sites: 0,
			stampsSurface: true,
			why: "synthetic payload-only caller pinned across files",
			pins: [
				{
					file: helperPath,
					label: "surface: ARTIFACT_SURFACES.api",
					pattern: /^\s*surface: ARTIFACT_SURFACES\.api,$/gm,
					min: 1,
				},
			],
		};
		try {
			const passing = buildResult([
				{ relPath: callerPath, source: "export const x = 1;" },
				{
					relPath: helperPath,
					source: "const row = {\n\tsurface: ARTIFACT_SURFACES.api,\n};",
				},
			]);
			expect(
				passing.violations.filter(
					(v: { kind: string; file: string }) =>
						v.file === callerPath && v.kind !== "stale-registry-entry",
				),
			).toEqual([]);

			const failing = buildResult([
				{ relPath: callerPath, source: "export const x = 1;" },
				{
					relPath: helperPath,
					source: "const row = {\n\tsurface: null,\n};",
				},
			]);
			expect(
				failing.violations.some(
					(v: { kind: string; file: string }) =>
						v.kind === "missing-surface-stamp" && v.file === callerPath,
				),
			).toBe(true);
		} finally {
			delete ARTIFACT_WRITE_SITES[callerPath];
		}
	});
});


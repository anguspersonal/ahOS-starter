/**
 * Unit tests for the owner-identity seam guard (#503 / ADR-045).
 *
 * The script is plain CommonJS at the repo root (matches sibling repo-wide
 * checks, e.g. scripts/check-type-duplicates.js), so it is loaded via
 * createRequire. Every test is pure static analysis of synthetic sources — no
 * env vars or database involved — except the last, which replays the guard
 * over the REAL committed packages/ tree and must pass (the same bar CI runs).
 *
 * The load-bearing pair: a synthetic file that REINTRODUCES a direct
 * `env.userId` read must FAIL the guard, and the accessor definition file plus
 * test files must be allowlisted.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	isTestPath,
	scanSource,
	buildResult,
	formatReport,
	readPackageFiles,
	PACKAGES_DIR,
} = require("../../../../scripts/check-user-id-reads.js");

const DIRECT_READ = 'const uid = env.userId;\n';
const SEAM_READ = 'const uid = getCurrentUserId();\n';

describe("isTestPath", () => {
	it("treats __tests__ directories and .test/.spec files as tests", () => {
		expect(isTestPath("packages/mcp-server/src/__tests__/capture.test.ts")).toBe(true);
		expect(isTestPath("packages/worker/src/foo.test.ts")).toBe(true);
		expect(isTestPath("packages/web/src/bar.spec.tsx")).toBe(true);
	});

	it("does not treat production files as tests", () => {
		expect(isTestPath("packages/mcp-server/src/tools/capture.ts")).toBe(false);
		expect(isTestPath("packages/mcp-server/src/integrations.ts")).toBe(false);
	});
});

describe("scanSource", () => {
	it("finds every occurrence with line and column", () => {
		const hits = scanSource("a\nconst x = env.userId;\nenv.userId; env.userId;\n");
		expect(hits).toHaveLength(3);
		expect(hits[0]).toMatchObject({ line: 2, column: 11 });
		expect(hits[1].line).toBe(3);
	});

	it("finds reads in comments too — the seam erodes via breadcrumbs", () => {
		expect(scanSource("// scope to env.userId here\n")).toHaveLength(1);
	});

	it("returns nothing for seam-respecting code", () => {
		expect(scanSource(SEAM_READ)).toHaveLength(0);
	});

	it("catches the raw process.env.KMS_USER_ID bypass in both forms", () => {
		expect(scanSource('const uid = process.env.KMS_USER_ID;\n')).toHaveLength(1);
		expect(scanSource('const uid = process.env["KMS_USER_ID"];\n')).toHaveLength(1);
		// Other env vars through process.env stay legal.
		expect(scanSource('const b = process.env.KMS_STORAGE_BUCKET;\n')).toHaveLength(0);
	});
});

describe("buildResult", () => {
	it("FAILS on a synthetic reintroduced direct read in production code", () => {
		const result = buildResult([
			{ relPath: "packages/mcp-server/src/tools/newTool.ts", source: DIRECT_READ },
		]);
		expect(result.ok).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]).toMatchObject({
			file: "packages/mcp-server/src/tools/newTool.ts",
			line: 1,
		});
	});

	it("allows the accessor's own definition file", () => {
		const result = buildResult([
			{
				relPath: "packages/mcp-server/src/identity.ts",
				source: "export function getCurrentUserId(): string {\n\treturn env.userId;\n}\n",
			},
		]);
		expect(result.ok).toBe(true);
		expect(result.filesAllowlisted).toBe(1);
	});

	it("FAILS on a raw process.env.KMS_USER_ID read in production code", () => {
		const result = buildResult([
			{
				relPath: "packages/mcp-server/src/tools/sneaky.ts",
				source: 'const uid = process.env.KMS_USER_ID;\n',
			},
		]);
		expect(result.ok).toBe(false);
		expect(result.violations).toHaveLength(1);
	});

	it("allows http-smoke.ts's child-env forwarding raw read", () => {
		const result = buildResult([
			{
				relPath: "packages/mcp-server/scripts/http-smoke.ts",
				source: 'KMS_USER_ID: process.env.KMS_USER_ID ?? "0",\n',
			},
		]);
		expect(result.ok).toBe(true);
		expect(result.filesAllowlisted).toBe(1);
	});

	it("allows test files to touch env.userId", () => {
		const result = buildResult([
			{ relPath: "packages/mcp-server/src/__tests__/bindings.test.ts", source: DIRECT_READ },
			{ relPath: "packages/worker/src/thing.spec.ts", source: DIRECT_READ },
		]);
		expect(result.ok).toBe(true);
	});

	it("mixed input: only the production read is reported", () => {
		const result = buildResult([
			{ relPath: "packages/mcp-server/src/identity.ts", source: "return env.userId;\n" },
			{ relPath: "packages/mcp-server/src/__tests__/a.test.ts", source: DIRECT_READ },
			{ relPath: "packages/mcp-server/src/links.ts", source: SEAM_READ },
			{ relPath: "packages/mcp-server/src/sneaky.ts", source: DIRECT_READ },
		]);
		expect(result.ok).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].file).toBe("packages/mcp-server/src/sneaky.ts");
	});
});

describe("formatReport", () => {
	it("names the violating file:line and points at the accessor", () => {
		const result = buildResult([
			{ relPath: "packages/mcp-server/src/sneaky.ts", source: DIRECT_READ },
		]);
		const report = formatReport(result).join("\n");
		expect(report).toContain("FAIL");
		expect(report).toContain("packages/mcp-server/src/sneaky.ts:1");
		expect(report).toContain("getCurrentUserId()");
	});

	it("reports OK when clean", () => {
		const report = formatReport(buildResult([])).join("\n");
		expect(report).toContain("OK");
	});
});

describe("real repository state", () => {
	it("the committed packages/ tree passes the guard", () => {
		// The same scan CI runs. If this fails, a direct env.userId read was
		// (re)introduced — route it through getCurrentUserId() instead.
		const result = buildResult(readPackageFiles(PACKAGES_DIR));
		expect(result.violations).toEqual([]);
		expect(result.ok).toBe(true);
		// Sanity: the walk really visited the tree.
		expect(result.filesScanned).toBeGreaterThan(100);
	});
});

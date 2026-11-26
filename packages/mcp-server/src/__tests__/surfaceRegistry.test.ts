import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "../server.js";
import { HTTP_ROUTE_EXEMPTIONS } from "../actions/httpRouteExemptions.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json") as {
	actions: Record<
		string,
		{ expose?: { mcp?: boolean; http?: boolean; ui_agent?: boolean; worker?: boolean } }
	>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_TOOLS_BASELINE_PATH = path.resolve(__dirname, "../../legacy-tools-baseline.txt");
const WEB_ACTIONS_BASELINE_PATH = path.resolve(__dirname, "../../web-actions-baseline.txt");
const JOB_ENQUEUE_BASELINE_PATH = path.resolve(__dirname, "../../job-enqueue-baseline.txt");
const HTTP_TS_PATH = path.resolve(__dirname, "../http.ts");
const WORKER_ROUTE_SURFACE_TEST_PATH = path.resolve(__dirname, "./workerRouteSurface.test.ts");
const WEB_ACTION_REGISTRY_PATH = path.resolve(__dirname, "../../../web/src/lib/actionRegistry.ts");

const SNAKE_CASE_NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".next", ".turbo"]);

export function verifyBaselineContent(
	label: string,
	found: Iterable<string>,
	rawContent: string | null,
	remediation: string,
): string[] {
	const errors: string[] = [];
	const foundSorted = [...new Set(found)].sort();
	if (rawContent === null) {
		for (const item of foundSorted) errors.push(`Unlisted ${label} "${item}": ${remediation}`);
		return errors;
	}
	const lines = rawContent.split(/\r?\n/).map((l) => l.trim());
	const comments = lines.filter((l) => l.startsWith("#")).join("\n");
	const entries = lines.filter((l) => l.length > 0 && !l.startsWith("#")).sort();
	if (!comments.includes("review:architect") || !/shrink/i.test(comments)) {
		errors.push(`${label} baseline must carry a # header with review:architect and shrink-only rule.`);
	}
	if (entries.length === 0) {
		errors.push(`${label} baseline has no entries and must be deleted when empty.`);
	}
	const baselineSet = new Set(entries);
	const foundSet = new Set(foundSorted);
	for (const item of foundSorted) {
		if (!baselineSet.has(item)) errors.push(`Unlisted ${label} "${item}": ${remediation}`);
	}
	for (const item of entries) {
		if (!foundSet.has(item)) errors.push(`Stale ${label} baseline entry "${item}": remove it.`);
	}
	return errors;
}

async function listAdvertisedMcpTools(): Promise<{ allNames: string[]; nonAliasNames: string[] }> {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-surface-registry", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();

	const toolMap = new Map(tools.map((t) => [t.name, t]));
	const aliases = new Set<string>();
	for (const tool of tools) {
		const desc = (tool.description ?? "").trim();
		const match = desc.match(/^Deprecated, use ([^.]+)\.\s*(.*)$/s);
		if (!match) continue;
		const target = toolMap.get(match[1]);
		if (target && match[2].trim() === (target.description ?? "").trim()) aliases.add(tool.name);
	}
	const allNames = tools.map((t) => t.name).sort();
	return { allNames, nonAliasNames: allNames.filter((n) => !aliases.has(n)) };
}

function collectHttpMounts(content: string): Set<string> {
	const mounts = new Set<string>();
	const re = /\bapp\.(?:get|post|put|patch|delete|all|use)\s*\(\s*(?:(['"])(.*?)\1|([a-zA-Z0-9_$]*Router)\b)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		const routeOrRouter = m[2] ?? m[3];
		if (routeOrRouter) mounts.add(routeOrRouter);
	}
	return mounts;
}

export function collectWebClientActionIds(registryFilePath = WEB_ACTION_REGISTRY_PATH): string[] {
	const registryDir = path.dirname(registryFilePath);
	const text = fs.readFileSync(registryFilePath, "utf8");
	const importMap = new Map<string, string>();
	const importRe = /import\s*\{([^}]+)\}\s*from\s*(['"])(\.[^'"]+)\2/g;
	let m: RegExpExecArray | null;
	while ((m = importRe.exec(text)) !== null) {
		const resolved = path.join(registryDir, m[3].replace(/\.js$/, ".ts"));
		for (const part of m[1].split(",")) {
			const cleaned = part.replace(/\btype\b/g, "").trim();
			if (cleaned) importMap.set(cleaned.split(/\s+as\s+/).pop()!.trim(), resolved);
		}
	}
	const ids = new Set<string>();
	const registerRe = /\.register\s*\(\s*(?:\{[\s\S]*?\bid\s*:\s*(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))/g;
	while ((m = registerRe.exec(text)) !== null) {
		if (m[2]) {
			ids.add(m[2]);
			continue;
		}
		const ident = m[3];
		const targetSource = fs.readFileSync(importMap.get(ident) ?? registryFilePath, "utf8");
		const defMatch = new RegExp(`\\b${ident}\\b[\\s\\S]*?\\bid\\s*:\\s*(['"])([^'"]+)\\1`).exec(targetSource);
		if (defMatch) ids.add(defMatch[2]);
	}
	return [...ids].sort();
}

export function scanJobEnqueues(): { allJobNames: string[]; outsideEnqueueActionJob: string[] } {
	const packagesDir = path.join(__dirname, "../../..");
	const canonicalJobsRel = "packages/core/src/adapters/supabase/jobs.ts";
	const allNames = new Set<string>();
	const outside = new Set<string>();

	function walk(dir: string) {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (/\.[jt]sx?$/.test(entry.name)) {
				const rel = path.relative(packagesDir, full).split(path.sep).join("/");
				const repoRel = `packages/${rel}`;
				if (!/^[^/]+\/src\//.test(rel) || repoRel.includes("/__tests__/") || repoRel.includes("/tests/") || /\.(?:test|spec|testkit)\.[jt]sx?$/.test(repoRel)) continue;
				const source = fs.readFileSync(full, "utf8");
				let em: RegExpExecArray | null;
				const enqueueRe = /\benqueueActionJob\s*\([^)]*?\{\s*actionId\s*:\s*(['"])([^'"]+)\1/gs;
				while ((em = enqueueRe.exec(source)) !== null) allNames.add(em[2]);
				if (repoRel === canonicalJobsRel) continue;
				const rawInsertRe = /\.from\s*\(\s*(['"])system_jobs\1\s*\)\s*\.insert\s*\(([\s\S]*?)\)/g;
				while ((em = rawInsertRe.exec(source)) !== null) {
					const tm = /\btype\s*:\s*(['"])([^'"]+)\1/.exec(em[2]);
					const name = tm ? tm[2] : `${repoRel}:raw_system_jobs_insert`;
					allNames.add(name);
					outside.add(name);
				}
			}
		}
	}
	walk(packagesDir);
	return { allJobNames: [...allNames].sort(), outsideEnqueueActionJob: [...outside].sort() };
}

describe("surface registry guard (#1555, ADR-105)", () => {
	it("Case 1 (MCP): advertised tools minus aliases equal manifest mcp ids plus legacy-tools-baseline.txt", async () => {
		const { nonAliasNames } = await listAdvertisedMcpTools();
		const manifestMcpIds = new Set(
			Object.entries(manifest.actions).filter(([, e]) => e.expose?.mcp === true).map(([id]) => id),
		);
		const advertisedSet = new Set(nonAliasNames);
		expect([...manifestMcpIds].filter((id) => !advertisedSet.has(id))).toEqual([]);
		const nonManifestTools = nonAliasNames.filter((name) => !manifestMcpIds.has(name));
		const rawBaseline = fs.existsSync(LEGACY_TOOLS_BASELINE_PATH) ? fs.readFileSync(LEGACY_TOOLS_BASELINE_PATH, "utf8") : null;
		expect(verifyBaselineContent("MCP tool", nonManifestTools, rawBaseline, "define it with defineAction in core and set expose.mcp (ADR-105)")).toEqual([]);
	});

	it("Case 2 (Routes): http.ts mounts equal HTTP_ROUTE_EXEMPTIONS keys plus /api/actions, and workerRouteSurface.test.ts exists", () => {
		const mounts = collectHttpMounts(fs.readFileSync(HTTP_TS_PATH, "utf8"));
		expect([...mounts].sort()).toEqual([...Object.keys(HTTP_ROUTE_EXEMPTIONS), "/api/actions"].sort());
		expect(fs.existsSync(WORKER_ROUTE_SURFACE_TEST_PATH)).toBe(true);
	});

	it("Case 3 (Web): every client action in actionRegistry.ts is a manifest http/ui_agent action or in web-actions-baseline.txt", () => {
		const webActionIds = collectWebClientActionIds();
		expect(webActionIds.length).toBeGreaterThan(0);
		const manifestWebIds = new Set(
			Object.entries(manifest.actions).filter(([, e]) => e.expose?.http === true || e.expose?.ui_agent === true).map(([id]) => id),
		);
		const nonManifestWebIds = webActionIds.filter((id) => !manifestWebIds.has(id));
		const rawBaseline = fs.existsSync(WEB_ACTIONS_BASELINE_PATH) ? fs.readFileSync(WEB_ACTIONS_BASELINE_PATH, "utf8") : null;
		expect(verifyBaselineContent("web client action", nonManifestWebIds, rawBaseline, "define it with defineAction in core and set expose.http or expose.ui_agent (ADR-105)")).toEqual([]);
	});

	it("Case 4 (Jobs): every system_jobs insert outside enqueueActionJob is in job-enqueue-baseline.txt (strict when absent)", () => {
		const { allJobNames, outsideEnqueueActionJob } = scanJobEnqueues();
		expect(allJobNames.length).toBeGreaterThan(0);
		const manifestWorkerIds = new Set(
			Object.entries(manifest.actions).filter(([, e]) => e.expose?.worker === true).map(([id]) => id),
		);
		const unexposed = allJobNames.filter((n) => !manifestWorkerIds.has(n) && !outsideEnqueueActionJob.includes(n));
		const unlistedJobs = [...new Set([...outsideEnqueueActionJob, ...unexposed])].sort();
		const rawBaseline = fs.existsSync(JOB_ENQUEUE_BASELINE_PATH) ? fs.readFileSync(JOB_ENQUEUE_BASELINE_PATH, "utf8") : null;
		expect(rawBaseline, "job-enqueue-baseline.txt must not exist when empty").toBeNull();
		expect(verifyBaselineContent("system_jobs enqueue", unlistedJobs, rawBaseline, "define it with defineAction in core with expose.worker and enqueue via enqueueActionJob (ADR-105)")).toEqual([]);
	});

	it("Case 5 (Naming): every name across all four lists matches snake_case", async () => {
		const { allNames: mcpNames } = await listAdvertisedMcpTools();
		const lists = [
			["mcp", mcpNames],
			["routes (/api/actions)", Object.keys(manifest.actions)],
			["web", collectWebClientActionIds()],
			["jobs", scanJobEnqueues().allJobNames],
		] as const;
		for (const [listName, names] of lists) {
			expect(names.filter((n) => !SNAKE_CASE_NAME_RE.test(n)), `Non-snake_case in ${listName}`).toEqual([]);
		}
	});

	it("Case 6 (Baseline ratchet): fails on unlisted names, stale baseline lines, missing headers, or empty baseline files", () => {
		expect(
			verifyBaselineContent("MCP tool", ["brand_new_tool"], "# review:architect shrink only\nexisting_tool\n", "define it with defineAction in core and set expose.mcp (ADR-105)"),
		).toEqual([
			expect.stringContaining("define it with defineAction in core and set expose.mcp (ADR-105)"),
			expect.stringContaining('Stale MCP tool baseline entry "existing_tool"'),
		]);
		expect(verifyBaselineContent("job", [], "# review:architect shrink only\n", "remediation")).toEqual([
			expect.stringContaining("must be deleted when empty"),
		]);
		expect(verifyBaselineContent("job", ["rogue_job"], null, "remediation")).toEqual([
			expect.stringContaining("Unlisted job"),
		]);
	});
});

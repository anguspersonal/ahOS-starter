import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SKILLS_DIR = path.resolve(REPO_ROOT, ".claude/skills");

export interface ToolRefLocation {
	name: string;
	file: string;
	line: number;
}

export function collectToolRefsWithLines(content: string, filePath: string): ToolRefLocation[] {
	const refs: ToolRefLocation[] = [];
	const backtickRegex = /`([^`]+)`/g;
	let match: RegExpExecArray | null;

	while ((match = backtickRegex.exec(content)) !== null) {
		const span = match[1].trim();
		const offset = match.index;
		const line = content.slice(0, offset).split("\n").length;

		// Check mcp__ahkms__<name>
		const mcpMatches = span.matchAll(/mcp__ahkms__([a-z][a-z0-9_]*)/g);
		for (const m of mcpMatches) {
			refs.push({ name: m[1], file: filePath, line });
		}

		// Check name( where name has an underscore: ^[a-z][a-z0-9]*(_[a-z0-9]+)+$
		const callMatches = span.matchAll(/\b([a-z][a-z0-9]*(_[a-z0-9]+)+)\s*\(/g);
		for (const m of callMatches) {
			refs.push({ name: m[1], file: filePath, line });
		}
	}

	return refs;
}

export function collectToolRefs(text: string): string[] {
	const refs = collectToolRefsWithLines(text, "fixture");
	return [...new Set(refs.map((r) => r.name))].sort();
}

export function collectSkillFiles(dir: string, fileList: string[] = []): string[] {
	if (!fs.existsSync(dir)) return fileList;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSkillFiles(fullPath, fileList);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			fileList.push(fullPath);
		}
	}
	return fileList;
}

export function collectToolRefsFromSkills(skillsDir: string = SKILLS_DIR): ToolRefLocation[] {
	const files = collectSkillFiles(skillsDir);
	const allRefs: ToolRefLocation[] = [];

	for (const file of files) {
		const content = fs.readFileSync(file, "utf8");
		allRefs.push(...collectToolRefsWithLines(content, file));
	}

	return allRefs;
}

async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-skill-refs", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

describe("repo skill tool references (#1559 / ADR-105 R11 / ADR-031)", () => {
	it("Case 1: collects at least 30 distinct tool names from .claude/skills/**/*.md", () => {
		const refs = collectToolRefsFromSkills();
		const distinctNames = new Set(refs.map((r) => r.name));
		expect(distinctNames.size).toBeGreaterThanOrEqual(30);
	});

	it("Case 2: every collected tool name is in client.listTools() from createServer()", async () => {
		const tools = await listTools();
		const advertisedNames = new Set(tools.map((t) => t.name));

		const refs = collectToolRefsFromSkills();
		const unadvertised = refs.filter((r) => !advertisedNames.has(r.name));

		const failures = unadvertised.map(
			(r) => `${path.relative(REPO_ROOT, r.file).replace(/\\/g, "/")}:${r.line} ${r.name}`,
		);

		expect(
			failures,
			`Skill tool reference(s) not advertised by MCP server:\n${failures.join("\n")}`,
		).toEqual([]);
	});

	it("Case 3: pure collectToolRefs on a fixture reports nope_tool( and ignores feat(, docs( and bare entity_query", () => {
		const fixture = [
			"Use `nope_tool(` or `nope_tool(arg)` to do something.",
			"Do not use `feat(web): add button` or `docs(api): update`.",
			"Check `entity_query` without parenthesis.",
			"Also `mcp__ahkms__sample_tool`.",
		].join("\n");

		const refs = collectToolRefs(fixture);
		expect(refs).toContain("nope_tool");
		expect(refs).toContain("sample_tool");
		expect(refs).not.toContain("feat");
		expect(refs).not.toContain("docs");
		expect(refs).not.toContain("entity_query");
		expect(refs).toEqual(["nope_tool", "sample_tool"]);
	});
});

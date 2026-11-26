import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSrcDir = resolve(__dirname, "..");

const require = createRequire(import.meta.url);
const manifest: {
	actions: Record<
		string,
		{
			expose: {
				mcp: boolean;
				http: boolean;
				ui_agent: boolean;
				worker: boolean;
				cli: boolean;
				a2a: boolean;
			};
		}
	>;
} = require("@ahkms/core/action-manifest.json");

const ENTITY_TOOL_IDS = [
	"entity_get",
	"entity_query",
	"entity_create",
	"entity_upsert",
	"entity_update",
	"entity_delete",
	"entity_crud",
	"entity_bulk_delete",
] as const;

const EXPECTED_INPUT_KEYS: Record<(typeof ENTITY_TOOL_IDS)[number], string[]> = {
	entity_get: ["id"],
	entity_query: [
		"query",
		"entity_type",
		"local_name",
		"namespace",
		"ids",
		"team_id",
		"user_id",
		"include_archived",
		"limit",
		"created_before",
		"updated_before",
		"tags",
		"domain",
		"include_properties",
	],
	entity_create: ["entities", "confidence"],
	entity_upsert: ["entities", "confidence"],
	entity_update: ["ids", "filter", "patch"],
	entity_delete: ["ids", "filter", "archive_only", "dry_run"],
	entity_crud: [
		"operation",
		"id",
		"ids",
		"entities",
		"query",
		"title",
		"description",
		"entity_type",
		"local_name",
		"namespace",
		"team_id",
		"user_id",
		"include_archived",
		"include_properties",
		"limit",
		"created_before",
		"updated_before",
		"tags",
		"domain",
		"filter",
		"patch",
		"archive_only",
		"dry_run",
	],
	entity_bulk_delete: ["ids", "filter", "archive_only", "dry_run"],
};

function walkTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkTsFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

describe("entity modules deleted from mcp-server (#1624)", () => {
	it("1. deletes tools/entities.ts, actions/entities.ts, and actions/entitiesPort.ts and removes all entity_ defineAction calls", () => {
		expect(existsSync(join(mcpSrcDir, "tools/entities.ts"))).toBe(false);
		expect(existsSync(join(mcpSrcDir, "actions/entities.ts"))).toBe(false);
		expect(existsSync(join(mcpSrcDir, "actions/entitiesPort.ts"))).toBe(false);

		const defineEntityRegex = /defineAction\s*\(\s*\{[\s\S]*?\bid\s*:\s*["']entity_/;
		const offenders = walkTsFiles(mcpSrcDir).filter((file) =>
			defineEntityRegex.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});

	it("2. advertises all eight entity tools via createServer() and listTools() with expected inputSchema keys and annotations", async () => {
		const tools = await listTools();
		const byName = new Map(tools.map((t) => [t.name, t]));

		for (const id of ENTITY_TOOL_IDS) {
			const tool = byName.get(id);
			expect(tool, `missing tool: ${id}`).toBeDefined();
			const props = Object.keys((tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
			expect(props.sort()).toEqual([...EXPECTED_INPUT_KEYS[id]].sort());

			const annotations = (tool!.annotations ?? {}) as Record<string, unknown>;
			expect(typeof annotations.readOnlyHint).toBe("boolean");
			expect(typeof annotations.destructiveHint).toBe("boolean");
			expect(typeof annotations.idempotentHint).toBe("boolean");
			expect(typeof annotations.openWorldHint).toBe("boolean");
		}
	});

	it("3. exposes all eight entity ids in @ahkms/core/action-manifest.json with mcp/http/ui_agent/worker true and cli/a2a false", () => {
		for (const id of ENTITY_TOOL_IDS) {
			const entry = manifest.actions[id];
			expect(entry, `missing manifest entry: ${id}`).toBeDefined();
			expect(entry.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
		}
	});
});

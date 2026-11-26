import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
	createKnowledgeSearchAction,
	KNOWLEDGE_SEARCH_DESCRIPTION,
	type SearchPort,
} from "@ahkms/core";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json") as {
	actions: Record<string, any>;
};


async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

describe("knowledge_search action migration (#1620)", () => {
	it("case 1: contract parity over in-memory MCP client + createServer()", async () => {
		const tools = await listTools();
		const tool = tools.find((t) => t.name === "knowledge_search");
		expect(tool).toBeDefined();
		expect(tool!.description).toBe(KNOWLEDGE_SEARCH_DESCRIPTION);
		expect(tool!.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
		expect(Object.keys(props).sort()).toEqual([
			"artifacts_only",
			"captured_after",
			"captured_before",
			"consumed_kinds",
			"domain",
			"include_archived",
			"include_daily_logs",
			"include_discovered",
			"include_event_requests",
			"include_reflections",
			"include_scaffolds",
			"include_task_requests",
			"limit",
			"not_consumed",
			"query",
			"rank_by_role",
			"roles",
			"tags",
		]);
		expect(tool!.inputSchema.required ?? []).toEqual([]);
		expect(props.query.type).toBe("string");
		expect(props.limit.type).toBe("integer");
		expect(props.captured_after.type).toBe("string");
		expect(props.captured_before.type).toBe("string");
		expect(props.not_consumed.type).toBe("boolean");
		expect(props.consumed_kinds.type).toBe("array");
		expect(props.domain.type).toBe("string");
		expect(props.include_archived.type).toBe("boolean");
		expect(props.include_task_requests.type).toBe("boolean");
		expect(props.include_event_requests.type).toBe("boolean");
		expect(props.include_daily_logs.type).toBe("boolean");
		expect(props.include_scaffolds.type).toBe("boolean");
		expect(props.include_reflections.type).toBe("boolean");
		expect(props.include_discovered.type).toBe("boolean");
		expect(props.rank_by_role.type).toBe("boolean");
		expect(props.roles.type).toBe("array");
		expect(props.tags.type).toBe("array");
		expect(props.artifacts_only.type).toBe("boolean");
	});

	it("case 2: exposure in packages/core/action-manifest.json", () => {
		const entry = manifest.actions.knowledge_search;
		expect(entry).toBeDefined();
		expect(entry.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("case 3: registration path in buildRegistry() and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry({});
		expect(registry.has("knowledge_search")).toBe(true);

		const baselineLines = readLegacyBaseline();
		expect(baselineLines).not.toContain("knowledge_search");
	});

	it("case 4: embedding port degrades on degradable error and when no key is configured", async () => {
		const search: SearchPort = {
			ftsSearchArtifacts: vi.fn(async () => [
				{
					id: "art-fts",
					title: "FTS Match",
					plain_text: "Body text",
					created_at: "2026-08-10T10:00:00Z",
					captured_at: "2026-08-10T10:00:00Z",
					effective_at: "2026-08-10T10:00:00Z",
					lifecycle_stage: "enriched",
					tags: null,
					content_subtype: null,
				},
			]),
			hybridSearchArtifacts: vi.fn(async () => []),
			searchGraph: vi.fn(async () => []),
			filterArtifacts: vi.fn(async () => ({ rows: [], count: 0 })),
			findConsumedArtifactIds: vi.fn(async () => []),
		};

		const degradedAction = createKnowledgeSearchAction({
			search,
			embeddings: {
				embed: vi.fn(async () => {
					throw new Error("OpenAI embeddings failed (503): service unavailable");
				}),
				embedBatch: vi.fn(),
			},
		});
		const degradedOut = await degradedAction.run(
			{ query: "strategy" },
			{ caller: "mcp", requestId: "req-1" },
		);
		expect(degradedOut.text).toContain(
			"search_mode: full-text-only (embedding provider unavailable: OpenAI embeddings failed (503): service unavailable",
		);
		expect(degradedOut.text).toContain("[art-fts] FTS Match");

		const noKeyAction = createKnowledgeSearchAction({ search, embeddings: null });
		const noKeyOut = await noKeyAction.run(
			{ query: "strategy" },
			{ caller: "mcp", requestId: "req-2" },
		);
		expect(noKeyOut.text).toContain(
			"search_mode: full-text-only (no OpenAI embedding key configured",
		);
		expect(noKeyOut.text).toContain("[art-fts] FTS Match");
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoreArtifactsPort } from "@ahkms/core";
import { buildRegistry } from "@ahkms/core/actions";
import { supabase } from "../supabase.js";
import { createServer } from "../server.js";

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
	vi.restoreAllMocks();
});

describe("capture over core ports without mcp-server supabase (#1658)", () => {
	it("succeeds over an in-memory MCP client when mcp-server supabase.from throws", async () => {
		(supabase as any).from = vi.fn(() => {
			throw new Error("mcp-server supabase.from must not be called");
		});
		(supabase.storage as any).from = vi.fn(() => {
			throw new Error("mcp-server supabase.storage.from must not be called");
		});

		const artifacts = createCoreArtifactsPort({
			ownerId: "user-core-1",
			storageBucket: "artifacts",
			config: {
				loadCapturePreferences: async () => ({
					create_derived_artifacts: true,
					default_tags: ["core"],
					default_source_channel: "mcp",
					tag_rules: [],
					default_surface: "claude_code",
					surface_trust_map: {},
					default_trust: "medium",
					default_role: "narrative",
					surface_role_map: {},
				}),
			},
			storage: {
				upload: vi.fn(async () => {}),
				remove: vi.fn(async () => {}),
				publicUrl: (bucket, path) => `https://example.test/${bucket}/${path}`,
			},
			artifacts: {
				findOldestByDedupKey: vi.fn(async () => null),
				findOldestByFingerprint: vi.fn(async () => null),
				insert: vi.fn(async (row) => ({
					id: row.id,
					title: row.title,
					created_at: "2026-09-24T12:00:00.000Z",
				})),
			},
			embeddings: {
				embed: vi.fn(async () => [0.1, 0.2]),
				embedBatch: vi.fn(async () => [[0.1, 0.2]]),
			},
			embeddingStore: {
				setEmbedding: vi.fn(async () => {}),
			},
		});

		const registry = buildRegistry({ artifacts });
		const server = createServer(undefined, undefined, registry);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const response = await client.callTool({
			name: "capture",
			arguments: { text: "Captured purely via core ports", title: "Core Capture" },
		});
		await client.close();

		expect(response.isError).toBeFalsy();
		const text = ((response.content as Array<{ type: string; text: string }>)[0]?.text ?? "");
		expect(text).toContain("Title: Core Capture");
		expect(text).toContain("Tags: core");
		expect(text).toContain("Channel: mcp");
	});
});

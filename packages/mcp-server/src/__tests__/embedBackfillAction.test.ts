import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	createArtifactEmbedBackfillAction,
	executeAction,
	type ActionAuditRecord,
	type EmbeddingBackfillStore,
	type EmbeddingPort,
} from "@ahkms/core";
import { buildRegistry } from "@ahkms/core/actions";
import { createEmbedBackfillCadence } from "@ahkms/core/engine";

import { createServer } from "../server.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json") as {
	actions: Record<
		string,
		{
			description: string;
			annotations: Record<string, boolean>;
			expose: Record<string, boolean>;
			input_schema: { properties?: Record<string, unknown> };
		}
	>;
};


describe("artifact_embed_backfill action registration & MCP parity (#1617)", () => {
	it("1. Contract parity: MCP lists artifact_embed_backfill with batch_size, max_batches, dry_run and expected annotations", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-embed-backfill", version: "0" }, { capabilities: {} });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "artifact_embed_backfill");
		expect(tool).toBeDefined();
		expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual([
			"batch_size",
			"dry_run",
			"max_batches",
		]);
		expect(tool!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
	});

	it("2. Exposure: artifact_embed_backfill is in action-manifest.json with mcp, http, ui_agent, worker true and cli, a2a false", () => {
		const entry = manifest.actions.artifact_embed_backfill;
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

	it("3. Registration path: returned by buildRegistry and serverRegistry and removed from legacy-tools-baseline.txt", () => {
		expect(buildRegistry({}).get("artifact_embed_backfill")).toBeDefined();
		expect(serverRegistry().get("artifact_embed_backfill")).toBeDefined();

		const baselineLines = readLegacyBaseline();
		expect(baselineLines).not.toContain("artifact_embed_backfill");
	});

	it("4. dry_run: true makes no provider call and writes nothing; rows without text are reported as skipped-no-text and stay in remaining", async () => {
		const store: EmbeddingBackfillStore = {
			setEmbedding: vi.fn(async () => {}),
			selectUnembeddedBatch: vi.fn(async (table, _batchSize, afterId) => {
				if (afterId || table === "entities") return [];
				return [
					{
						id: "a-empty",
						title: null,
						description: null,
						plain_text: null,
						extracted_content: null,
					},
				];
			}),
			countRemaining: vi.fn(async (table) => (table === "artifacts" ? 1 : 0)),
		};
		const embeddings: EmbeddingPort = {
			embed: vi.fn(async () => [0.1, 0.2]),
			embedBatch: vi.fn(async () => [[0.1, 0.2]]),
		};
		const action = createArtifactEmbedBackfillAction({ store, embeddings });
		const res = await executeAction(action, { dry_run: true }, { context: { caller: "mcp" } });

		expect(embeddings.embed).not.toHaveBeenCalled();
		expect(store.setEmbedding).not.toHaveBeenCalled();
		expect(res.artifacts.remaining).toBe(1);
		const text = action.formatMcp!(res);
		expect(text).toContain("skipped-no-text=1");
		expect(text).toContain("remaining=1");
	});


	it("5. Engine cadence runs artifact_embed_backfill via executeAction with caller 'worker'", async () => {
		const auditRecords: ActionAuditRecord[] = [];
		const store: EmbeddingBackfillStore = {
			setEmbedding: vi.fn(async () => {}),
			selectUnembeddedBatch: vi.fn(async () => []),
			countRemaining: vi.fn(async () => 0),
		};
		const embeddings: EmbeddingPort = {
			embed: vi.fn(async () => [0.1]),
			embedBatch: vi.fn(async () => [[0.1]]),
		};

		const cadence = createEmbedBackfillCadence({
			ports: { store, embeddings },
			userId: "worker-owner",
			auditSink: async (rec) => {
				auditRecords.push(rec);
			},
		});
		await cadence.run();

		expect(auditRecords).toHaveLength(1);
		expect(auditRecords[0]).toMatchObject({
			actionId: "artifact_embed_backfill",
			caller: "worker",
			outcome: "success",
		});
	});
});

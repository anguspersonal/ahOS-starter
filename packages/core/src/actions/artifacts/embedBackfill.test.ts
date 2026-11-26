import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import type {
	BackfillArtifactRow,
	BackfillEntityRow,
	EmbeddableTable,
	EmbeddingBackfillStore,
	EmbeddingPort,
} from "../../ports/embeddings.js";
import {
	ARTIFACT_EMBED_BACKFILL_DESCRIPTION,
	createArtifactEmbedBackfillAction,
} from "./embedBackfill.js";

function makeInMemoryBackfillStore(seed: {
	artifacts?: Array<BackfillArtifactRow & { embedding?: number[] | null }>;
	entities?: Array<BackfillEntityRow & { embedding?: number[] | null }>;
}) {
	const artifacts = (seed.artifacts ?? []).map((r) => ({ ...r, embedding: r.embedding ?? null }));
	const entities = (seed.entities ?? []).map((r) => ({ ...r, embedding: r.embedding ?? null }));

	const store: EmbeddingBackfillStore = {
		setEmbedding: vi.fn(async (table: EmbeddableTable, id: string, vector: number[]) => {
			const list = table === "entities" ? entities : artifacts;
			const row = list.find((r) => r.id === id);
			if (row) {
				row.embedding = vector;
			}
		}),
		selectUnembeddedBatch: vi.fn(
			async (table: EmbeddableTable, batchSize: number, afterId: string | null) => {
				const list = table === "entities" ? entities : artifacts;
				return list
					.filter((r) => r.embedding === null && (!afterId || r.id > afterId))
					.sort((a, b) => a.id.localeCompare(b.id))
					.slice(0, batchSize)
					.map(({ embedding: _e, ...rest }) => ({ ...rest }));
			},
		),
		countRemaining: vi.fn(async (table: EmbeddableTable) => {
			const list = table === "entities" ? entities : artifacts;
			return list.filter((r) => r.embedding === null).length;
		}),
	};

	return { store, artifacts, entities };
}

describe("artifact_embed_backfill core action (#1617)", () => {
	it("1. preserves contract parity: snake_case id, input schema keys, annotations, description, and default exposure", () => {
		const { store } = makeInMemoryBackfillStore({});
		const action = createArtifactEmbedBackfillAction({
			store,
			embeddings: {
				embed: async () => [0.1, 0.2],
				embedBatch: async () => [[0.1, 0.2]],
			},
		});

		expect(action.id).toBe("artifact_embed_backfill");
		expect(action.description).toBe(ARTIFACT_EMBED_BACKFILL_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});

		const jsonSchema = z.toJSONSchema(action.schema, { target: "openapi-3.0", io: "input" }) as {
			properties?: Record<string, unknown>;
		};
		expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual([
			"batch_size",
			"dry_run",
			"max_batches",
		]);

		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});


	it("2. dry_run: true makes no provider call and writes nothing; rows without text are reported as skipped-no-text and stay in remaining", async () => {
		const { store, artifacts } = makeInMemoryBackfillStore({
			artifacts: [
				{
					id: "a-1",
					title: "First doc",
					description: null,
					plain_text: "Some body text",
					extracted_content: null,
				},
				{
					id: "a-2",
					title: null,
					description: null,
					plain_text: null,
					extracted_content: null,
				},
			],
			entities: [],
		});
		const embedPort: EmbeddingPort = {
			embed: vi.fn(async () => [0.1, 0.2, 0.3]),
			embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
		};
		const action = createArtifactEmbedBackfillAction({
			store,
			embeddings: embedPort,
		});

		const result = await executeAction(
			action,
			{ dry_run: true },
			{ context: { caller: "mcp", userId: "user-1" } },
		);

		expect(embedPort.embed).not.toHaveBeenCalled();
		expect(store.setEmbedding).not.toHaveBeenCalled();
		expect(artifacts.every((r) => r.embedding === null)).toBe(true);
		expect(result.artifacts).toEqual({
			scanned: 2,
			embedded: 1,
			failed: 0,
			remaining: 2,
		});

		const text = action.formatMcp!(result);
		expect(text).toContain("dry run");
		expect(text).toContain("skipped-no-text=1");
		expect(text).toContain("remaining=2");
	});

	it("3. embeds unembedded artifacts and entities, writes vectors back, and reports no-text rows in remaining", async () => {
		const { store, artifacts, entities } = makeInMemoryBackfillStore({
			artifacts: [
				{
					id: "a-1",
					title: "Artifact one",
					description: null,
					plain_text: "Body one",
					extracted_content: null,
				},
				{
					id: "a-2",
					title: null,
					description: null,
					plain_text: null,
					extracted_content: null,
				},
			],
			entities: [
				{
					id: "e-1",
					title: "Entity one",
					description: "Person in graph",
					properties: {},
				},
			],
		});
		const embedPort: EmbeddingPort = {
			embed: vi.fn(async () => [0.5, 0.6]),
			embedBatch: vi.fn(async () => [[0.5, 0.6]]),
		};
		const action = createArtifactEmbedBackfillAction({
			store,
			embeddings: embedPort,
		});

		const result = await executeAction(
			action,
			{ batch_size: 25, max_batches: 2, dry_run: false },
			{ context: { caller: "mcp", userId: "user-1" } },
		);

		expect(embedPort.embed).toHaveBeenCalledTimes(2);
		expect(store.setEmbedding).toHaveBeenCalledTimes(2);
		expect(artifacts.find((r) => r.id === "a-1")?.embedding).toEqual([0.5, 0.6]);
		expect(artifacts.find((r) => r.id === "a-2")?.embedding).toBeNull();
		expect(entities.find((r) => r.id === "e-1")?.embedding).toEqual([0.5, 0.6]);

		expect(result.artifacts).toEqual({
			scanned: 2,
			embedded: 1,
			failed: 0,
			remaining: 1,
		});
		expect(result.entities).toEqual({
			scanned: 1,
			embedded: 1,
			failed: 0,
			remaining: 0,
		});

		const text = action.formatMcp!(result);
		expect(text).toContain("artifacts: scanned=2 embedded=1 failed=0 skipped-no-text=1 remaining=1");
		expect(text).toContain("entities: scanned=1 embedded=1 failed=0 remaining=0");
		expect(text).toContain("Backlog drained");
	});
});


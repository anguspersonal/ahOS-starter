import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActionAuditRecord } from "../../actions/types.js";
import type { EmbeddingBackfillStore, EmbeddingPort } from "../../ports/embeddings.js";
import { createEmbedBackfillCadence } from "./embedBackfill.js";

describe("createEmbedBackfillCadence (#1617)", () => {
	it("runs artifact_embed_backfill via executeAction with caller 'worker' and calls no embedding code directly", async () => {
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
			userId: "user-worker-1",
			batchSize: 10,
			maxBatches: 1,
			auditSink: async (record) => {
				auditRecords.push(record);
			},
		});

		const result = await cadence.run();
		expect(result).toMatchObject({
			artifacts: { scanned: 0, embedded: 0, failed: 0, remaining: 0 },
			entities: { scanned: 0, embedded: 0, failed: 0, remaining: 0 },
		});
		expect(auditRecords).toHaveLength(1);
		expect(auditRecords[0]).toMatchObject({
			actionId: "artifact_embed_backfill",
			caller: "worker",
			userId: "user-worker-1",
			outcome: "success",
		});

		const cadenceSource = fs.readFileSync(
			path.resolve(import.meta.dirname, "./embedBackfill.ts"),
			"utf8",
		);
		expect(cadenceSource).toContain("actionCadence(");
		expect(cadenceSource).not.toMatch(/embedAndStore|withEmbeddingRetry|embedText|embedEntityText/);
	});
});

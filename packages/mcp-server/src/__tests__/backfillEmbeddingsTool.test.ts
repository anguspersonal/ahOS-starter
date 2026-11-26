/**
 * artifact_embed_backfill tool surface (#427).
 *
 * The backfill core (src/embeddings/backfill.ts) is covered by backfill.test.ts.
 * This file covers only what the tool wrapper adds on top: the per-call budget
 * defaults that keep one MCP call bounded, the arg mapping, and the summary text
 * a caller reads to decide whether to call again.
 *
 * The core is mocked out here deliberately — the point is the wrapper's own
 * behaviour, not a second copy of the batching tests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../embeddings/backfill.js", () => ({
	runEmbeddingBackfill: vi.fn(),
}));

import { runEmbeddingBackfill } from "../embeddings/backfill.js";
import { backfillEmbeddingsHandler } from "../tools/backfillEmbeddings.js";

const mockRun = vi.mocked(runEmbeddingBackfill);

afterEach(() => {
	vi.clearAllMocks();
});

/** Stub one backfill result; unspecified counters default to a clean run. */
function resolves(result: Partial<Awaited<ReturnType<typeof runEmbeddingBackfill>>>) {
	mockRun.mockResolvedValue({
		scanned: 0,
		embedded: 0,
		failed: 0,
		remaining: 0,
		...result,
	});
}

async function callTool(args: Record<string, unknown> = {}): Promise<string> {
	const result = await backfillEmbeddingsHandler(args as never);
	return result.content[0].text;
}

describe("backfillEmbeddingsHandler — per-call budget", () => {
	it("applies a bounded default budget so one MCP call cannot run unbounded, once per table (#551)", async () => {
		resolves({ scanned: 50, embedded: 50, remaining: 230 });

		await callTool();

		// 25 * 2 = 50 rows/call. The specific numbers matter less than the fact
		// that maxBatches is always set — leaving it undefined makes the core
		// drain the ENTIRE backlog in one call, which is what would hang a client.
		// Two tables (artifacts, entities — #551) means two calls, each budgeted
		// the same way and distinguished only by `table`.
		expect(mockRun).toHaveBeenCalledTimes(2);
		expect(mockRun).toHaveBeenCalledWith({ batchSize: 25, maxBatches: 2, dryRun: false, table: "artifacts" });
		expect(mockRun).toHaveBeenCalledWith({ batchSize: 25, maxBatches: 2, dryRun: false, table: "entities" });
	});

	it("passes caller overrides through to both tables", async () => {
		resolves({ scanned: 200, embedded: 200, remaining: 80 });

		await callTool({ batch_size: 100, max_batches: 2, dry_run: true });

		expect(mockRun).toHaveBeenCalledWith({ batchSize: 100, maxBatches: 2, dryRun: true, table: "artifacts" });
		expect(mockRun).toHaveBeenCalledWith({ batchSize: 100, maxBatches: 2, dryRun: true, table: "entities" });
	});
});

describe("backfillEmbeddingsHandler — summary", () => {
	it("tells the caller to call again while work remains", async () => {
		resolves({ scanned: 50, embedded: 50, remaining: 230 });

		const text = await callTool();

		expect(text).toContain("embedded=50");
		expect(text).toContain("remaining=230");
		expect(text).toContain("call artifact_embed_backfill again");
	});

	it("reports a drained backlog rather than telling the caller to call again", async () => {
		resolves({ scanned: 12, embedded: 12, remaining: 0 });

		const text = await callTool();

		expect(text).toContain("Backlog drained");
		expect(text).not.toContain("call artifact_embed_backfill again");
	});

	it("surfaces no-text rows separately, since they sit in `remaining` forever", async () => {
		// 10 scanned, 7 embedded, 0 failed => 3 had nothing to embed. Those rows
		// stay embedding IS NULL by design, so a caller looping until remaining
		// hits 0 would never terminate without being told about them.
		resolves({ scanned: 10, embedded: 7, failed: 0, remaining: 3 });

		const text = await callTool();

		expect(text).toContain("skipped-no-text=3");
		expect(text).toContain("no embeddable text");
	});

	it("omits the no-text note when every scanned row was embeddable", async () => {
		resolves({ scanned: 10, embedded: 10, failed: 0, remaining: 5 });

		const text = await callTool();

		expect(text).not.toContain("skipped-no-text");
		expect(text).not.toContain("no embeddable text");
	});

	it("calls out failures, which are retried rather than lost", async () => {
		resolves({ scanned: 50, embedded: 48, failed: 2, remaining: 32 });

		const text = await callTool();

		expect(text).toContain("failed=2");
		expect(text).toContain("retried on the next call");
	});

	it("marks a dry run so its counts are not mistaken for writes", async () => {
		resolves({ scanned: 50, embedded: 50, remaining: 280 });

		const text = await callTool({ dry_run: true });

		expect(text).toContain("dry run — nothing written");
	});

	it("reports each table separately, distinguishing entities/people from artifacts (#551)", async () => {
		mockRun.mockImplementation(async (opts) =>
			opts?.table === "entities"
				? { scanned: 3, embedded: 3, failed: 0, remaining: 0 }
				: { scanned: 50, embedded: 50, failed: 0, remaining: 230 },
		);

		const text = await callTool();

		expect(text).toContain("artifacts: scanned=50");
		expect(text).toContain("entities: scanned=3");
		// The artifacts backlog isn't drained, but entities is — each table's
		// verdict must be its own, not one bleeding into the other's report.
		expect(text).toContain("Backlog drained — every embeddable entity/person now has a vector.");
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock env so tests control openaiApiKey presence without depending on process.env
// (mirrors search.test.ts). Keep the real supabaseUrl/supabaseServiceRoleKey/userId
// via importOriginal since supabase.ts constructs a real client from them at import
// time, and backfill.ts scopes every query to env.userId.
vi.mock("../env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../env.js")>();
	return {
		...actual,
		env: {
			...actual.env,
			geminiApiKey: undefined as string | undefined,
			openaiApiKey: undefined as string | undefined,
		},
	};
});

// Mock embeddings.js so no real OpenAI call is ever made. embedText mirrors the
// real implementation (join non-empty fields) by default; individual tests can
// override embedText/embed's implementation to exercise failure paths.
// `embedWithRetry` — what the backfill actually calls — delegates to `embed` so the
// retry seam is transparent here; the backoff itself is covered in
// embeddingRetry.test.ts, and tests that care about exhausted retries stub
// embedWithRetry directly rather than waiting on real timers.
vi.mock("../embeddings.js", () => {
	const embed = vi.fn();
	return {
		embedText: vi.fn(),
		embedEntityText: vi.fn(),
		embed,
		embedWithRetry: vi.fn((text: string) => embed(text)),
	};
});

import { supabase } from "../supabase.js";
import { env } from "../env.js";
import { embedText, embedEntityText, embed, embedWithRetry } from "../embeddings.js";
import { runEmbeddingBackfill, backfillExitCode } from "../embeddings/backfill.js";

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env

type FakeRow = {
	id: string;
	title: string | null;
	description: string | null;
	plain_text: string | null;
	extracted_content: string | null;
	embedding: string | null;
	user_id: string;
	archived: boolean;
};

function row(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
	return {
		id,
		title: `Title ${id}`,
		description: null,
		plain_text: `Body text for ${id}`,
		extracted_content: null,
		embedding: null,
		user_id: TEST_USER,
		archived: false,
		...overrides,
	};
}

/** An error shaped like the OpenAI SDK's 429 (quota exhausted — issue #486). */
function rateLimitError(): Error & { status: number } {
	return Object.assign(new Error("429 You exceeded your current quota"), { status: 429 });
}

/** An error shaped like the OpenAI SDK's 401 (revoked/invalid key). */
function authError(): Error & { status: number } {
	return Object.assign(new Error("401 Incorrect API key provided"), { status: 401 });
}

/**
 * A minimal in-memory fake of the supabase-js chainable query builder, backing
 * an `artifacts` table with real filter/order/limit/update semantics so tests
 * don't have to hand-predict exact call sequences — just the same WHERE/ORDER/
 * LIMIT behaviour real Postgres would apply. Every builder method returns
 * itself and is stashed as query state; `.then()` (awaiting the builder, with
 * or without a terminal `.limit()`) executes it against the fake table.
 */
function makeArtifactsMock(initialRows: FakeRow[]) {
	const table: FakeRow[] = initialRows.map((r) => ({ ...r }));
	const log: { kind: "select" | "count" | "update" }[] = [];

	function builder() {
		const filters: Array<(r: FakeRow) => boolean> = [];
		let orderCol: keyof FakeRow | null = null;
		let ascending = true;
		let limitN: number | null = null;
		let mode: "select" | "update" | "count" = "select";
		let updatePayload: Partial<FakeRow> | null = null;

		const b: any = {
			select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
				if (opts?.head) mode = "count";
				return b;
			},
			update: (payload: Partial<FakeRow>) => {
				mode = "update";
				updatePayload = payload;
				return b;
			},
			eq: (col: keyof FakeRow, val: unknown) => {
				filters.push((r) => r[col] === val);
				return b;
			},
			is: (col: keyof FakeRow, val: unknown) => {
				filters.push((r) => r[col] === val);
				return b;
			},
			gt: (col: keyof FakeRow, val: unknown) => {
				filters.push((r) => (r[col] as unknown as string) > (val as string));
				return b;
			},
			order: (col: keyof FakeRow, opts?: { ascending?: boolean }) => {
				orderCol = col;
				ascending = opts?.ascending !== false;
				return b;
			},
			limit: (n: number) => {
				limitN = n;
				return b;
			},
			then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
				try {
					if (mode === "update") {
						for (const r of table) {
							if (filters.every((f) => f(r))) Object.assign(r, updatePayload);
						}
						log.push({ kind: "update" });
						resolve({ data: null, error: null });
						return;
					}

					let matched = table.filter((r) => filters.every((f) => f(r)));
					if (orderCol) {
						const col = orderCol;
						matched = [...matched].sort((a, c) => {
							if (a[col] === c[col]) return 0;
							return (a[col]! > c[col]! ? 1 : -1) * (ascending ? 1 : -1);
						});
					}

					if (mode === "count") {
						log.push({ kind: "count" });
						resolve({ count: matched.length, error: null });
						return;
					}

					if (limitN != null) matched = matched.slice(0, limitN);
					log.push({ kind: "select" });
					resolve({ data: matched.map((r) => ({ ...r })), error: null });
				} catch (err) {
					reject(err);
				}
			},
		};
		return b;
	}

	const fromMock = vi.fn((tableName: string) => {
		if (tableName !== "artifacts") throw new Error(`unexpected table: ${tableName}`);
		return builder();
	});

	return { fromMock, table, log };
}

type FakeEntityRow = {
	id: string;
	title: string | null;
	description: string | null;
	properties: Record<string, unknown> | null;
	embedding: string | null;
	user_id: string;
	archived: boolean;
};

function entityRow(id: string, overrides: Partial<FakeEntityRow> = {}): FakeEntityRow {
	return {
		id,
		title: `Entity ${id}`,
		description: null,
		properties: {},
		embedding: null,
		user_id: TEST_USER,
		archived: false,
		...overrides,
	};
}

/**
 * Same in-memory fake as makeArtifactsMock, backing an `entities` table instead
 * (#551). Kept as a thin sibling rather than a generalised helper: the two
 * fixtures' row shapes and column semantics differ enough (properties vs
 * plain_text/extracted_content) that sharing one generic would obscure more
 * than it'd save.
 */
function makeEntitiesMock(initialRows: FakeEntityRow[]) {
	const table: FakeEntityRow[] = initialRows.map((r) => ({ ...r }));
	const log: { kind: "select" | "count" | "update" }[] = [];

	function builder() {
		const filters: Array<(r: FakeEntityRow) => boolean> = [];
		let orderCol: keyof FakeEntityRow | null = null;
		let ascending = true;
		let limitN: number | null = null;
		let mode: "select" | "update" | "count" = "select";
		let updatePayload: Partial<FakeEntityRow> | null = null;

		const b: any = {
			select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
				if (opts?.head) mode = "count";
				return b;
			},
			update: (payload: Partial<FakeEntityRow>) => {
				mode = "update";
				updatePayload = payload;
				return b;
			},
			eq: (col: keyof FakeEntityRow, val: unknown) => {
				filters.push((r) => r[col] === val);
				return b;
			},
			is: (col: keyof FakeEntityRow, val: unknown) => {
				filters.push((r) => r[col] === val);
				return b;
			},
			gt: (col: keyof FakeEntityRow, val: unknown) => {
				filters.push((r) => (r[col] as unknown as string) > (val as string));
				return b;
			},
			order: (col: keyof FakeEntityRow, opts?: { ascending?: boolean }) => {
				orderCol = col;
				ascending = opts?.ascending !== false;
				return b;
			},
			limit: (n: number) => {
				limitN = n;
				return b;
			},
			then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
				try {
					if (mode === "update") {
						for (const r of table) {
							if (filters.every((f) => f(r))) Object.assign(r, updatePayload);
						}
						log.push({ kind: "update" });
						resolve({ data: null, error: null });
						return;
					}

					let matched = table.filter((r) => filters.every((f) => f(r)));
					if (orderCol) {
						const col = orderCol;
						matched = [...matched].sort((a, c) => {
							if (a[col] === c[col]) return 0;
							return (a[col]! > c[col]! ? 1 : -1) * (ascending ? 1 : -1);
						});
					}

					if (mode === "count") {
						log.push({ kind: "count" });
						resolve({ count: matched.length, error: null });
						return;
					}

					if (limitN != null) matched = matched.slice(0, limitN);
					log.push({ kind: "select" });
					resolve({ data: matched.map((r) => ({ ...r })), error: null });
				} catch (err) {
					reject(err);
				}
			},
		};
		return b;
	}

	const fromMock = vi.fn((tableName: string) => {
		if (tableName !== "entities") throw new Error(`unexpected table: ${tableName}`);
		return builder();
	});

	return { fromMock, table, log };
}

function defaultEmbedText(a: {
	title?: string | null;
	description?: string | null;
	plain_text?: string | null;
	extracted_content?: string | null;
}): string {
	return [a.title, a.description, a.plain_text, a.extracted_content]
		.filter(Boolean)
		.join(" ")
		.trim();
}

function defaultEmbedEntityText(e: { title?: string | null; description?: string | null }): string {
	return [e.title, e.description].filter(Boolean).join(" ").trim();
}

const origFrom = supabase.from;

beforeEach(() => {
	// Re-establish a known-good default before every test rather than relying on
	// afterEach cleanup semantics for vi.mock-factory functions.
	vi.mocked(embedText).mockReset().mockImplementation(defaultEmbedText);
	vi.mocked(embedEntityText).mockReset().mockImplementation(defaultEmbedEntityText);
	vi.mocked(embed)
		.mockReset()
		.mockImplementation(async () => [0.1, 0.2, 0.3]);
	vi.mocked(embedWithRetry)
		.mockReset()
		.mockImplementation((text: string) => embed(text));
});

afterEach(() => {
	(supabase as any).from = origFrom;
	(env as { geminiApiKey?: string; openaiApiKey?: string }).geminiApiKey = undefined;
	(env as { geminiApiKey?: string; openaiApiKey?: string }).openaiApiKey = undefined;
});

describe("runEmbeddingBackfill — selection, embedding, counts (#427)", () => {
	it("selects only embedding IS NULL rows, embeds each via embedText/embed, writes the vector back, and returns correct counts", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock, table } = makeArtifactsMock([
			row("a1"),
			row("a2"),
			row("a3", { embedding: JSON.stringify([0.9, 0.9, 0.9]) }), // already embedded — must not be touched
		]);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill();

		expect(result).toEqual({ scanned: 2, embedded: 2, failed: 0, remaining: 0 });
		expect(embedText).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Title a1", plain_text: "Body text for a1" }),
		);
		expect(embedText).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Title a2", plain_text: "Body text for a2" }),
		);
		expect(embedText).toHaveBeenCalledTimes(2); // a3 never selected (embedding not null)

		expect(JSON.parse(table.find((r) => r.id === "a1")!.embedding!)).toEqual([0.1, 0.2, 0.3]);
		expect(JSON.parse(table.find((r) => r.id === "a2")!.embedding!)).toEqual([0.1, 0.2, 0.3]);
		expect(JSON.parse(table.find((r) => r.id === "a3")!.embedding!)).toEqual([0.9, 0.9, 0.9]); // untouched
	});

	it("batches correctly: 120 rows with batchSize 50 takes 3 batches and embeds everything", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const rows = Array.from({ length: 120 }, (_, i) => row(`id-${String(i).padStart(4, "0")}`));
		const { fromMock, log } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 50 });

		expect(result).toEqual({ scanned: 120, embedded: 120, failed: 0, remaining: 0 });
		expect(log.filter((e) => e.kind === "select")).toHaveLength(3);
	});

	it("maxBatches caps the run: 120 rows, batchSize 50, maxBatches 2 processes only 100", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const rows = Array.from({ length: 120 }, (_, i) => row(`id-${String(i).padStart(4, "0")}`));
		const { fromMock, log } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 50, maxBatches: 2 });

		expect(result).toEqual({ scanned: 100, embedded: 100, failed: 0, remaining: 20 });
		expect(log.filter((e) => e.kind === "select")).toHaveLength(2);
	});

	it("counts a row whose embedText throws as failed without aborting the run — other rows still embed", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		vi.mocked(embedText).mockImplementation((a) => {
			if (a.title === "BOOM") throw new Error("embedText exploded");
			return defaultEmbedText(a);
		});
		const { fromMock, table } = makeArtifactsMock([
			row("b1"),
			row("b2", { title: "BOOM" }),
			row("b3"),
		]);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill();

		expect(result).toEqual({ scanned: 3, embedded: 2, failed: 1, remaining: 1 });
		expect(table.find((r) => r.id === "b2")!.embedding).toBeNull(); // failed row left untouched
		expect(JSON.parse(table.find((r) => r.id === "b1")!.embedding!)).toEqual([0.1, 0.2, 0.3]);
		expect(JSON.parse(table.find((r) => r.id === "b3")!.embedding!)).toEqual([0.1, 0.2, 0.3]);
	});

	it("no-ops (no embedText, no embed, no supabase queries) when OPENAI_API_KEY is unset", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { fromMock } = makeArtifactsMock([row("c1")]);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill();

		expect(result).toEqual({ scanned: 0, embedded: 0, failed: 0, remaining: 0 });
		expect(embedText).not.toHaveBeenCalled();
		expect(embed).not.toHaveBeenCalled();
		expect(fromMock).not.toHaveBeenCalled();
	});

	it("runs when GEMINI_API_KEY is set and OPENAI_API_KEY is unset (#1974)", async () => {
		(env as { geminiApiKey?: string; openaiApiKey?: string }).geminiApiKey = "gemini-key";
		(env as { geminiApiKey?: string; openaiApiKey?: string }).openaiApiKey = undefined;
		const { fromMock } = makeArtifactsMock([row("g1")]);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill();

		expect(result).toEqual({ scanned: 1, embedded: 1, failed: 0, remaining: 0 });
		expect(embedText).toHaveBeenCalledTimes(1);
		expect(embed).toHaveBeenCalledTimes(1);
	});

	it("skips a row with no embeddable text (counted, not embedded/failed) without looping forever", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock, table, log } = makeArtifactsMock([
			row("d1"),
			row("d2", { title: null, plain_text: null, extracted_content: null }), // nothing to embed
			row("d3"),
		]);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 1 });

		expect(result).toEqual({ scanned: 3, embedded: 2, failed: 0, remaining: 1 });
		expect(table.find((r) => r.id === "d2")!.embedding).toBeNull(); // stays NULL — nothing to embed
		// Cursor-based paging means each row is fetched at most once per run even
		// though d2 can never satisfy "embedding IS NULL" being resolved — bounded
		// number of round trips (batchSize 1 over 3 rows), not an infinite loop.
		expect(log.filter((e) => e.kind === "select").length).toBeLessThanOrEqual(4);
	});

	it("embeds a pointer's description too, so discovered rows are backfillable from their summary alone (#427)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock } = makeArtifactsMock([
			row("p1", { title: "Venue shortlist", description: "Five venues, costs and capacity", plain_text: null }),
		]);
		(supabase as any).from = fromMock;

		await runEmbeddingBackfill();

		expect(embedText).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Venue shortlist",
				description: "Five venues, costs and capacity",
			}),
		);
	});

	it("dryRun builds embed text and counts outcomes but calls neither embed() nor the DB write", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock, table } = makeArtifactsMock([row("e1")]);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ dryRun: true });

		expect(result).toEqual({ scanned: 1, embedded: 1, failed: 0, remaining: 1 });
		expect(embedText).toHaveBeenCalled();
		expect(embed).not.toHaveBeenCalled();
		expect(table.find((r) => r.id === "e1")!.embedding).toBeNull(); // no write in dry run
	});
});

describe("runEmbeddingBackfill — idempotency & resumability (#427)", () => {
	it("re-running after a complete pass embeds nothing and makes no provider calls", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock, table } = makeArtifactsMock([row("i1"), row("i2")]);
		(supabase as any).from = fromMock;

		const first = await runEmbeddingBackfill();
		expect(first).toEqual({ scanned: 2, embedded: 2, failed: 0, remaining: 0 });
		const vectorsAfterFirst = table.map((r) => r.embedding);

		vi.mocked(embed).mockClear();
		const second = await runEmbeddingBackfill();

		// The `embedding IS NULL` predicate IS the work queue: a second pass finds
		// nothing, so re-running is safe and never double-writes a row.
		expect(second).toEqual({ scanned: 0, embedded: 0, failed: 0, remaining: 0 });
		expect(embed).not.toHaveBeenCalled();
		expect(table.map((r) => r.embedding)).toEqual(vectorsAfterFirst);
	});

	it("resumes the leftover backlog on the next call after maxBatches capped the first", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const rows = Array.from({ length: 30 }, (_, i) => row(`r-${String(i).padStart(3, "0")}`));
		const { fromMock, table } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const first = await runEmbeddingBackfill({ batchSize: 10, maxBatches: 1 });
		expect(first).toEqual({ scanned: 10, embedded: 10, failed: 0, remaining: 20 });

		const second = await runEmbeddingBackfill({ batchSize: 10, maxBatches: 1 });
		expect(second).toEqual({ scanned: 10, embedded: 10, failed: 0, remaining: 10 });

		// Exactly 20 rows embedded across the two calls — the second call picked up
		// where the first stopped rather than starting over.
		expect(table.filter((r) => r.embedding !== null)).toHaveLength(20);
		expect(embed).toHaveBeenCalledTimes(20);
	});
});

describe("runEmbeddingBackfill — rate-limit handling (#427 / #486)", () => {
	it("stops the run after 3 consecutive rate-limited rows instead of burning the whole backlog", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		// Every row 429s even after its retries are exhausted — i.e. the account is out
		// of quota, not momentarily throttled.
		vi.mocked(embedWithRetry).mockRejectedValue(rateLimitError());
		const rows = Array.from({ length: 20 }, (_, i) => row(`q-${String(i).padStart(3, "0")}`));
		const { fromMock, table } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 10 });

		expect(result.rateLimited).toBe(true);
		expect(result.failed).toBe(3); // circuit breaker trips on the 3rd, not the 20th
		expect(result.embedded).toBe(0);
		expect(result.remaining).toBe(20); // backlog intact — re-run once quota is back
		expect(embedWithRetry).toHaveBeenCalledTimes(3);
		expect(table.every((r) => r.embedding === null)).toBe(true);
	});

	it("does not trip the breaker when rate limits are interleaved with successes", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		let call = 0;
		vi.mocked(embedWithRetry).mockImplementation(async () => {
			call += 1;
			// Fail on every other row: never 3 in a row, so this is throttling to ride
			// out, not an exhausted account.
			if (call % 2 === 1) throw rateLimitError();
			return [0.1, 0.2, 0.3];
		});
		const rows = Array.from({ length: 6 }, (_, i) => row(`m-${i}`));
		const { fromMock } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 10 });

		expect(result.rateLimited).toBeUndefined();
		expect(result.scanned).toBe(6);
		expect(result.embedded).toBe(3);
		expect(result.failed).toBe(3);
	});

	it("keeps going on a couple of non-rate-limit failures — a bad row must not stop the backlog", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		// 2 consecutive failures — under NON_RETRYABLE_CIRCUIT_BREAK (3), so this is
		// "a couple of rows had a problem", not "the account is broken".
		vi.mocked(embedWithRetry).mockRejectedValue(new Error("input too long for model"));
		const rows = Array.from({ length: 2 }, (_, i) => row(`x-${i}`));
		const { fromMock } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 10 });

		expect(result.rateLimited).toBeUndefined();
		expect(result.configError).toBeUndefined();
		expect(result.scanned).toBe(2);
		expect(result.failed).toBe(2);
	});

	it("stops the run after 3 consecutive auth failures instead of burning the whole backlog (round 1 QA review, #515)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		// A revoked/invalid key fails every row identically — auth is never retried
		// inside embedWithRetry, so each row is a single doomed call.
		vi.mocked(embedWithRetry).mockRejectedValue(authError());
		const rows = Array.from({ length: 20 }, (_, i) => row(`k-${String(i).padStart(3, "0")}`));
		const { fromMock, table } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 10 });

		expect(result.configError).toBe(true);
		expect(result.rateLimited).toBeUndefined();
		expect(result.failed).toBe(3); // circuit breaker trips on the 3rd, not the 20th
		expect(result.embedded).toBe(0);
		expect(result.remaining).toBe(20); // backlog intact — re-run once the key is fixed
		expect(embedWithRetry).toHaveBeenCalledTimes(3);
		expect(table.every((r) => r.embedding === null)).toBe(true);
	});

	it("stops the run after 3 consecutive unclassifiable failures too — the breaker isn't auth-specific", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		vi.mocked(embedWithRetry).mockRejectedValue(new Error("something is very wrong"));
		const rows = Array.from({ length: 10 }, (_, i) => row(`u-${i}`));
		const { fromMock } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 10 });

		expect(result.configError).toBe(true);
		expect(result.failed).toBe(3);
		expect(result.remaining).toBe(10);
	});

	it("does not trip the non-retryable breaker when auth-class failures are interleaved with successes", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		let call = 0;
		vi.mocked(embedWithRetry).mockImplementation(async () => {
			call += 1;
			if (call % 2 === 1) throw authError();
			return [0.1, 0.2, 0.3];
		});
		const rows = Array.from({ length: 6 }, (_, i) => row(`n-${i}`));
		const { fromMock } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 10 });

		expect(result.configError).toBeUndefined();
		expect(result.rateLimited).toBeUndefined();
		expect(result.scanned).toBe(6);
		expect(result.embedded).toBe(3);
		expect(result.failed).toBe(3);
	});

	it("trips the rate-limit breaker on an alternating rate-limit/auth/rate-limit/auth/rate-limit sequence (round 2 QA review, #515)", async () => {
		// Round 1's fix had each failure kind reset the *other* kind's counter, so an
		// alternating sequence never let either counter reach its threshold and neither
		// breaker ever tripped. With counters resetting only on success (not on the
		// other kind's failure), 3 rate-limit failures still accumulate even with auth
		// failures interleaved between them — this is the case round 1 missed.
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		let call = 0;
		vi.mocked(embedWithRetry).mockImplementation(async () => {
			call += 1;
			// rate_limit, auth, rate_limit, auth, rate_limit, ... — never 3 of the same
			// kind back-to-back, but 3 rate_limits accumulate by the 5th call.
			if (call % 2 === 1) throw rateLimitError();
			throw authError();
		});
		const rows = Array.from({ length: 20 }, (_, i) => row(`alt-${String(i).padStart(3, "0")}`));
		const { fromMock, table } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 10 });

		expect(result.rateLimited).toBe(true);
		expect(result.configError).toBeUndefined();
		expect(result.failed).toBe(5); // rl, auth, rl, auth, rl — breaker trips on the 5th call
		expect(result.embedded).toBe(0);
		expect(result.remaining).toBe(20); // backlog intact
		expect(embedWithRetry).toHaveBeenCalledTimes(5);
		expect(table.every((r) => r.embedding === null)).toBe(true);
	});

	it("trips the non-retryable breaker on an alternating auth/rate-limit/auth/rate-limit/auth sequence", async () => {
		// Same bug, mirrored: starting with auth instead of rate-limit should trip the
		// non-retryable breaker instead, still without either resetting the other.
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		let call = 0;
		vi.mocked(embedWithRetry).mockImplementation(async () => {
			call += 1;
			if (call % 2 === 1) throw authError();
			throw rateLimitError();
		});
		const rows = Array.from({ length: 20 }, (_, i) => row(`alt2-${String(i).padStart(3, "0")}`));
		const { fromMock } = makeArtifactsMock(rows);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ batchSize: 10 });

		expect(result.configError).toBe(true);
		expect(result.rateLimited).toBeUndefined();
		expect(result.failed).toBe(5);
		expect(embedWithRetry).toHaveBeenCalledTimes(5);
	});

	it("passes its (more patient) retry budget down to the embedding call", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock } = makeArtifactsMock([row("t1")]);
		(supabase as any).from = fromMock;

		await runEmbeddingBackfill();

		expect(embedWithRetry).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ maxAttempts: 5, baseDelayMs: 1_000 }),
		);
	});

	it("honours caller-supplied retry overrides", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock } = makeArtifactsMock([row("t2")]);
		(supabase as any).from = fromMock;

		await runEmbeddingBackfill({ retryMaxAttempts: 2, retryBaseDelayMs: 10 });

		expect(embedWithRetry).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ maxAttempts: 2, baseDelayMs: 10 }),
		);
	});
});

describe("runEmbeddingBackfill — table: 'entities' (#551 / ADR-047 §2)", () => {
	it("defaults to 'artifacts' when table is omitted — pre-#551 callers are unaffected", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock } = makeArtifactsMock([row("z1")]);
		(supabase as any).from = fromMock;

		await runEmbeddingBackfill();

		expect(fromMock).toHaveBeenCalledWith("artifacts");
	});

	it("sweeps entities.embedding IS NULL rows via embedEntityText, and writes to entities.embedding", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { fromMock, table } = makeEntitiesMock([
			entityRow("e1"),
			entityRow("e2", { embedding: JSON.stringify([0.9, 0.9, 0.9]) }), // already embedded
		]);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ table: "entities" });

		expect(result).toEqual({ scanned: 1, embedded: 1, failed: 0, remaining: 0 });
		expect(embedEntityText).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Entity e1" }),
		);
		expect(embedText).not.toHaveBeenCalled();
		expect(JSON.parse(table.find((r) => r.id === "e1")!.embedding!)).toEqual([0.1, 0.2, 0.3]);
		expect(JSON.parse(table.find((r) => r.id === "e2")!.embedding!)).toEqual([0.9, 0.9, 0.9]); // untouched
	});

	it("resumes the entities backlog across calls, same as artifacts", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const rows = Array.from({ length: 30 }, (_, i) => entityRow(`r-${String(i).padStart(3, "0")}`));
		const { fromMock, table } = makeEntitiesMock(rows);
		(supabase as any).from = fromMock;

		const first = await runEmbeddingBackfill({ table: "entities", batchSize: 10, maxBatches: 1 });
		expect(first).toEqual({ scanned: 10, embedded: 10, failed: 0, remaining: 20 });

		const second = await runEmbeddingBackfill({ table: "entities", batchSize: 10, maxBatches: 1 });
		expect(second).toEqual({ scanned: 10, embedded: 10, failed: 0, remaining: 10 });

		expect(table.filter((r) => r.embedding !== null)).toHaveLength(20);
	});

	it("skips an entity with no embeddable text (no title/description/role/organization/relationship)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		vi.mocked(embedEntityText).mockImplementation(() => "");
		const { fromMock, table } = makeEntitiesMock([entityRow("d1", { title: null })]);
		(supabase as any).from = fromMock;

		const result = await runEmbeddingBackfill({ table: "entities" });

		expect(result).toEqual({ scanned: 1, embedded: 0, failed: 0, remaining: 1 });
		expect(table.find((r) => r.id === "d1")!.embedding).toBeNull();
	});
});

// scripts/backfill-embeddings.ts (a tsx entry point, not something `vitest run`
// imports) is a thin wrapper whose only decision is this exit code — pulled out
// as backfillExitCode so that decision has real coverage. Round 1 added
// `configError` to BackfillResult but the script never gained a matching check,
// so a revoked API key still exited 0 silently (round 2 QA review, #515).
describe("backfillExitCode — CLI exit-code contract (round 2 QA review, #515)", () => {
	it("exits 0 on a clean run (no rateLimited, no configError)", () => {
		expect(backfillExitCode({ scanned: 5, embedded: 5, failed: 0, remaining: 0 } as any)).toBe(0);
		expect(backfillExitCode({})).toBe(0);
	});

	it("exits 1 when the run stopped early on rateLimited", () => {
		expect(backfillExitCode({ rateLimited: true })).toBe(1);
	});

	it("exits 1 when the run stopped early on configError — the case the script silently missed", () => {
		expect(backfillExitCode({ configError: true })).toBe(1);
	});

	it("exits 1 if somehow both flags are set (defensive — the two breakers are documented as mutually exclusive)", () => {
		expect(backfillExitCode({ rateLimited: true, configError: true })).toBe(1);
	});
});

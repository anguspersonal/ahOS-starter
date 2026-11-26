/**
 * embedAndStore -- table-aware generalisation (#551 / ADR-047 section 2; #1615).
 * Originally hard-wired to `artifacts`; now takes a `table` argument and routes
 * the text build (embedText vs embedEntityText) and the write (`.from(table).update(...)`)
 * accordingly, while keeping the contract identical: best-effort, never throws,
 * `embedding IS NULL` on any failure/no-key/no-text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn<typeof fetch>();

vi.mock("../env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../env.js")>();
	return {
		...actual,
		env: {
			...actual.env,
			geminiApiKey: undefined as string | undefined,
			openaiApiKey: "test-key" as string | undefined,
		},
	};
});

import { supabase } from "../supabase.js";
import { env } from "../env.js";
import { embedAndStore } from "../embeddings.js";

const VECTOR = [0.1, 0.2, 0.3];
const okResponse = () =>
	new Response(JSON.stringify({ data: [{ embedding: VECTOR }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	mockFetch.mockReset();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	(env as { geminiApiKey?: string; openaiApiKey?: string }).geminiApiKey = undefined;
	(env as { geminiApiKey?: string; openaiApiKey?: string }).openaiApiKey = "test-key";
});

describe("embedAndStore -- table routing (#551)", () => {
	it("embeds an entities row from title/description/properties and writes to entities.embedding", async () => {
		mockFetch.mockResolvedValueOnce(okResponse());
		let updatedTable = "";
		let updatedPayload: unknown;
		let updatedId = "";
		(supabase as any).from = vi.fn((table: string) => {
			updatedTable = table;
			return {
				update: (payload: unknown) => ({
					eq: (_col: string, id: string) => {
						updatedPayload = payload;
						updatedId = id;
						return Promise.resolve({ error: null });
					},
				}),
			};
		});

		const outcome = await embedAndStore("entities", "e1", {
			title: "Sam",
			description: null,
			properties: { role: "CEO" },
		});

		expect(outcome).toBe("embedded");
		expect(updatedTable).toBe("entities");
		expect(updatedId).toBe("e1");
		expect(JSON.parse((updatedPayload as { embedding: string }).embedding)).toEqual(VECTOR);
		// The text actually sent to the provider proves embedEntityText (not
		// embedText) was used -- "role" only surfaces via the entity composition.
		const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body)) as { input: string };
		expect(body.input).toContain("CEO");
	});

	it("still embeds an artifacts row from title/plain_text (unchanged pre-#551 behaviour)", async () => {
		mockFetch.mockResolvedValueOnce(okResponse());
		let updatedTable = "";
		(supabase as any).from = vi.fn((table: string) => {
			updatedTable = table;
			return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
		});

		const outcome = await embedAndStore("artifacts", "a1", { title: "Doc", plain_text: "body" });

		expect(outcome).toBe("embedded");
		expect(updatedTable).toBe("artifacts");
	});

	it("skips without touching supabase when no OPENAI_API_KEY is set", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const fromSpy = vi.fn();
		(supabase as any).from = fromSpy;

		const outcome = await embedAndStore("entities", "e2", { title: "Sam" });

		expect(outcome).toBe("skipped");
		expect(fromSpy).not.toHaveBeenCalled();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("skips an entities row with no embeddable text (e.g. only unrelated properties keys)", async () => {
		const fromSpy = vi.fn();
		(supabase as any).from = fromSpy;

		const outcome = await embedAndStore("entities", "e3", {
			title: null,
			description: null,
			properties: { email: "sam@example.com" },
		});

		expect(outcome).toBe("skipped");
		expect(fromSpy).not.toHaveBeenCalled();
	});

	it("returns 'failed' and leaves the row untouched when the DB write errors", async () => {
		mockFetch.mockResolvedValueOnce(okResponse());
		(supabase as any).from = vi.fn(() => ({
			update: () => ({ eq: () => Promise.resolve({ error: { message: "boom" } }) }),
		}));

		const outcome = await embedAndStore("entities", "e4", { title: "Sam" });

		expect(outcome).toBe("failed");
	});

	it("embeds via Gemini when GEMINI_API_KEY is set and OPENAI_API_KEY is unset (#1974)", async () => {
		(env as { geminiApiKey?: string; openaiApiKey?: string }).geminiApiKey = "gemini-key";
		(env as { geminiApiKey?: string; openaiApiKey?: string }).openaiApiKey = undefined;
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ embedding: { values: VECTOR } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		(supabase as any).from = vi.fn(() => ({
			update: () => ({ eq: () => Promise.resolve({ error: null }) }),
		}));

		const outcome = await embedAndStore("artifacts", "a-gemini", {
			title: "Gemini Doc",
			plain_text: "body",
		});

		expect(outcome).toBe("embedded");
		expect(String(mockFetch.mock.calls[0][0])).toMatch(
			/\/v1beta\/models\/gemini-embedding-001:embedContent$/,
		);
	});
});

/**
 * embed() context-length retry (#427, migrated to fetch adapter in #1615).
 *
 * MAX_CHARS truncates by CHARS (28k) but the model caps INPUT BY TOKENS (8192).
 * Token-dense artifacts (code, URLs, non-Latin text) fit the char budget yet
 * overflow the token cap, and the API rejects them with a 400 "maximum context
 * length is 8192 tokens".
 *
 * embed() halves the input and retries when -- and only when -- the error is
 * the context-length 400. These tests pin that behaviour by stubbing fetch; no
 * network involved.
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

import { env } from "../env.js";
import { embed, embedBatch } from "../embeddings.js";

const VECTOR = [0.1, 0.2, 0.3];
const okResponse = () =>
	new Response(JSON.stringify({ data: [{ embedding: VECTOR }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
const contextLengthResponse = () =>
	new Response(
		JSON.stringify({
			error: { message: "Invalid 'input': maximum context length is 8192 tokens." },
		}),
		{
			status: 400,
			headers: { "Content-Type": "application/json" },
		},
	);
const rateLimitResponse = () =>
	new Response(
		JSON.stringify({
			error: { message: "rate limit exceeded" },
		}),
		{
			status: 429,
			headers: { "Content-Type": "application/json" },
		},
	);

function inputOfCall(callIndex: number): string {
	const init = mockFetch.mock.calls[callIndex]?.[1];
	const parsed = JSON.parse(String(init?.body)) as { input: string };
	return parsed.input;
}

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	mockFetch.mockReset();
	vi.unstubAllGlobals();
	(env as { geminiApiKey?: string; openaiApiKey?: string }).geminiApiKey = undefined;
	(env as { geminiApiKey?: string; openaiApiKey?: string }).openaiApiKey = "test-key";
});

describe("embed -- context-length retry (#427)", () => {
	it("returns the vector with no retry when the input is accepted", async () => {
		mockFetch.mockResolvedValueOnce(okResponse());

		expect(await embed("short text")).toEqual(VECTOR);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("halves the input and retries on the context-length 400", async () => {
		mockFetch
			.mockResolvedValueOnce(contextLengthResponse())
			.mockResolvedValueOnce(okResponse());
		const text = "x".repeat(28_000);

		expect(await embed(text)).toEqual(VECTOR);

		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(inputOfCall(0)).toHaveLength(28_000);
		expect(inputOfCall(1)).toHaveLength(14_000);
	});

	it("keeps halving until the model accepts", async () => {
		mockFetch
			.mockResolvedValueOnce(contextLengthResponse())
			.mockResolvedValueOnce(contextLengthResponse())
			.mockResolvedValueOnce(okResponse());

		expect(await embed("x".repeat(28_000))).toEqual(VECTOR);

		expect(mockFetch).toHaveBeenCalledTimes(3);
		expect(inputOfCall(2)).toHaveLength(7_000);
	});

	it("rethrows a non-context-length error without retrying", async () => {
		mockFetch.mockResolvedValueOnce(rateLimitResponse());

		await expect(embed("x".repeat(28_000))).rejects.toThrow(/rate limit/);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("gives up at the retry floor rather than looping forever", async () => {
		// A context-length error on an already-tiny input can't be truncation's
		// fault -- propagate it as a real failure instead of shaving to nothing.
		mockFetch.mockImplementation(async () => contextLengthResponse());

		await expect(embed("x".repeat(500))).rejects.toThrow(/maximum context length/);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("prefers Gemini 1536d embeddings when GEMINI_API_KEY is set (#1974)", async () => {
		(env as { geminiApiKey?: string }).geminiApiKey = "gemini-test-key";
		mockFetch
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ embedding: { values: VECTOR } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ embeddings: [{ values: VECTOR }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		expect(await embed("hello gemini")).toEqual(VECTOR);
		expect(await embedBatch(["batch gemini"])).toEqual([VECTOR]);

		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(String(mockFetch.mock.calls[0][0])).toMatch(
			/\/v1beta\/models\/gemini-embedding-001:embedContent$/,
		);
		expect(mockFetch.mock.calls[0][1]?.headers).toEqual({
			"x-goog-api-key": "gemini-test-key",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({
			model: "models/gemini-embedding-001",
			content: { parts: [{ text: "hello gemini" }] },
			outputDimensionality: 1536,
		});
		expect(String(mockFetch.mock.calls[1][0])).toMatch(
			/\/v1beta\/models\/gemini-embedding-001:batchEmbedContents$/,
		);
	});
});

import { describe, expect, it, vi } from "vitest";
import { createOpenAiEmbeddingAdapter } from "./embeddings.js";
import { classifyEmbeddingError, retryAfterMs } from "../../domain/embeddings.js";

const SECRET_KEY = "test-openai-key-placeholder";
const VECTOR = [0.1, 0.2, 0.3];

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
	const status = init?.status ?? 200;
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
}

describe("createOpenAiEmbeddingAdapter", () => {
	it("POSTs https://api.openai.com/v1/embeddings with configured model and bearer key and returns data[0].embedding", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			jsonResponse({ data: [{ embedding: VECTOR, index: 0 }] }),
		);
		const adapter = createOpenAiEmbeddingAdapter({
			apiKey: SECRET_KEY,
			model: "text-embedding-3-small",
			fetchFn,
		});

		const result = await adapter.embed("hello world");

		expect(result).toEqual(VECTOR);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe("https://api.openai.com/v1/embeddings");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			Authorization: `Bearer ${SECRET_KEY}`,
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "text-embedding-3-small",
			input: "hello world",
		});
	});

	it("halves the input on a 400 context-length error down to 1,000 characters, then throws", async () => {
		const contextErrBody = {
			error: { message: "Invalid 'input': maximum context length is 8192 tokens." },
		};
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(contextErrBody, { status: 400 }))
			.mockResolvedValueOnce(jsonResponse(contextErrBody, { status: 400 }))
			.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: VECTOR, index: 0 }] }));

		const adapter = createOpenAiEmbeddingAdapter({ apiKey: SECRET_KEY, fetchFn });
		const result = await adapter.embed("x".repeat(28_000));

		expect(result).toEqual(VECTOR);
		expect(fetchFn).toHaveBeenCalledTimes(3);
		expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).input).toHaveLength(28_000);
		expect(JSON.parse(String(fetchFn.mock.calls[1][1]?.body)).input).toHaveLength(14_000);
		expect(JSON.parse(String(fetchFn.mock.calls[2][1]?.body)).input).toHaveLength(7_000);

		const alwaysFailFetch = vi.fn<typeof fetch>(async () =>
			jsonResponse(contextErrBody, { status: 400 }),
		);
		const failingAdapter = createOpenAiEmbeddingAdapter({
			apiKey: SECRET_KEY,
			fetchFn: alwaysFailFetch,
		});
		await expect(failingAdapter.embed("x".repeat(500))).rejects.toThrow(/maximum context length/);
		expect(alwaysFailFetch).toHaveBeenCalledTimes(1);
	});

	it("attaches HTTP status and headers (including retry-after) on non-2xx responses", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			jsonResponse(
				{ error: { message: "Rate limit reached" } },
				{ status: 429, headers: { "retry-after": "4" } },
			),
		);
		const adapter = createOpenAiEmbeddingAdapter({ apiKey: SECRET_KEY, fetchFn });

		let caught: unknown;
		try {
			await adapter.embed("hello");
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(classifyEmbeddingError(caught)).toBe("rate_limit");
		expect(retryAfterMs(caught)).toBe(4000);
	});

	it("embedBatch slices each input to 28,000 characters, orders vectors by data[i].index, and throws on a missing index", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				data: [
					{ index: 1, embedding: [0.3, 0.4] },
					{ index: 0, embedding: [0.1, 0.2] },
				],
			}),
		);
		const adapter = createOpenAiEmbeddingAdapter({ apiKey: SECRET_KEY, fetchFn });

		expect(await adapter.embedBatch([])).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();

		const vectors = await adapter.embedBatch(["a".repeat(30_000), "second"]);
		expect(vectors).toEqual([
			[0.1, 0.2],
			[0.3, 0.4],
		]);
		const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body)) as { input: string[] };
		expect(body.input[0]).toHaveLength(28_000);
		expect(body.input[1]).toBe("second");

		fetchFn.mockResolvedValueOnce(
			jsonResponse({
				data: [{ index: 0, embedding: [0.1, 0.2] }],
			}),
		);
		await expect(adapter.embedBatch(["first", "second"])).rejects.toThrow(
			/embedding batch returned no vector for input 1/,
		);
	});

	it("never includes the API key in any error message", async () => {
		const missingKeyAdapter = createOpenAiEmbeddingAdapter({ apiKey: () => undefined });
		await expect(missingKeyAdapter.embed("hello")).rejects.toThrow(/OPENAI_API_KEY not set/);

		const leakFetch = vi.fn<typeof fetch>(async () =>
			jsonResponse(
				{ error: { message: `Incorrect API key provided: ${SECRET_KEY}` } },
				{ status: 401 },
			),
		);
		const adapter = createOpenAiEmbeddingAdapter({ apiKey: SECRET_KEY, fetchFn: leakFetch });

		let caught: Error | undefined;
		try {
			await adapter.embed("hello");
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).not.toContain(SECRET_KEY);
		expect(caught?.message).toContain("[REDACTED]");
	});
});

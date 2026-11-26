import { describe, expect, it, vi } from "vitest";
import { createGeminiEmbeddingAdapter } from "./embeddings.js";
import { classifyEmbeddingError, retryAfterMs } from "../../domain/embeddings.js";

const SECRET_KEY = "AIzaSy-super-secret-gemini-key-12345";
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

describe("createGeminiEmbeddingAdapter", () => {
	it("POSTs :embedContent with x-goog-api-key header, gemini-embedding-001, and outputDimensionality 1536", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			jsonResponse({ embedding: { values: VECTOR } }),
		);
		const adapter = createGeminiEmbeddingAdapter({
			apiKey: SECRET_KEY,
			fetchFn,
		});

		const result = await adapter.embed("hello world");

		expect(result).toEqual(VECTOR);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent",
		);
		expect(String(url)).not.toContain(SECRET_KEY);
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			"x-goog-api-key": SECRET_KEY,
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "models/gemini-embedding-001",
			content: { parts: [{ text: "hello world" }] },
			outputDimensionality: 1536,
		});
	});

	it("halves the input on a 400 token-limit error down to 1,000 characters, then throws", async () => {
		const contextErrBody = {
			error: { message: "Request payload size exceeds the limit: too many tokens." },
		};
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(contextErrBody, { status: 400 }))
			.mockResolvedValueOnce(jsonResponse(contextErrBody, { status: 400 }))
			.mockResolvedValueOnce(jsonResponse({ embedding: { values: VECTOR } }));

		const adapter = createGeminiEmbeddingAdapter({ apiKey: SECRET_KEY, fetchFn });
		const result = await adapter.embed("x".repeat(28_000));

		expect(result).toEqual(VECTOR);
		expect(fetchFn).toHaveBeenCalledTimes(3);
		expect(
			JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).content.parts[0].text,
		).toHaveLength(28_000);
		expect(
			JSON.parse(String(fetchFn.mock.calls[1][1]?.body)).content.parts[0].text,
		).toHaveLength(14_000);
		expect(
			JSON.parse(String(fetchFn.mock.calls[2][1]?.body)).content.parts[0].text,
		).toHaveLength(7_000);

		const alwaysFailFetch = vi.fn<typeof fetch>(async () =>
			jsonResponse(contextErrBody, { status: 400 }),
		);
		const failingAdapter = createGeminiEmbeddingAdapter({
			apiKey: SECRET_KEY,
			fetchFn: alwaysFailFetch,
		});
		await expect(failingAdapter.embed("x".repeat(500))).rejects.toThrow(/too many tokens/);
		expect(alwaysFailFetch).toHaveBeenCalledTimes(1);
	});

	it("attaches HTTP status and headers (including retry-after) on non-2xx responses", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			jsonResponse(
				{ error: { message: "Quota exceeded for metric" } },
				{ status: 429, headers: { "retry-after": "4" } },
			),
		);
		const adapter = createGeminiEmbeddingAdapter({ apiKey: SECRET_KEY, fetchFn });

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

	it("embedBatch POSTs :batchEmbedContents, slices each input to 28,000 characters, and throws on a missing vector", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
			}),
		);
		const adapter = createGeminiEmbeddingAdapter({ apiKey: SECRET_KEY, fetchFn });

		expect(await adapter.embedBatch([])).toEqual([]);
		expect(fetchFn).not.toHaveBeenCalled();

		const vectors = await adapter.embedBatch(["a".repeat(30_000), "second"]);
		expect(vectors).toEqual([
			[0.1, 0.2],
			[0.3, 0.4],
		]);
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
		);
		const body = JSON.parse(String(init?.body)) as {
			requests: Array<{
				model: string;
				content: { parts: Array<{ text: string }> };
				outputDimensionality: number;
			}>;
		};
		expect(body.requests).toHaveLength(2);
		expect(body.requests[0].model).toBe("models/gemini-embedding-001");
		expect(body.requests[0].outputDimensionality).toBe(1536);
		expect(body.requests[0].content.parts[0].text).toHaveLength(28_000);
		expect(body.requests[1].content.parts[0].text).toBe("second");

		fetchFn.mockResolvedValueOnce(
			jsonResponse({
				embeddings: [{ values: [0.1, 0.2] }],
			}),
		);
		await expect(adapter.embedBatch(["first", "second"])).rejects.toThrow(
			/embedding batch returned no vector for input 1/,
		);
	});

	it("never includes the API key in any error message", async () => {
		const missingKeyAdapter = createGeminiEmbeddingAdapter({ apiKey: () => undefined });
		await expect(missingKeyAdapter.embed("hello")).rejects.toThrow(/GEMINI_API_KEY not set/);

		const leakFetch = vi.fn<typeof fetch>(async () =>
			jsonResponse(
				{ error: { message: `API key not valid. Please pass a valid API key: ${SECRET_KEY}` } },
				{ status: 403 },
			),
		);
		const adapter = createGeminiEmbeddingAdapter({ apiKey: SECRET_KEY, fetchFn: leakFetch });

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

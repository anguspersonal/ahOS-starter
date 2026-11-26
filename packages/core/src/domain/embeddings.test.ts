import { describe, expect, it, vi } from "vitest";
import {
	classifyEmbeddingError,
	embedAndStore,
	embedEntityText,
	embedText,
	isDegradableEmbeddingError,
	isRetryableEmbeddingError,
	retryAfterMs,
	withEmbeddingRetry,
} from "./embeddings.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../ports/embeddings.js";

const FAST = { baseDelayMs: 1 };

function apiError(status: number, message = `HTTP ${status}`): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

describe("embedText", () => {
	it("joins title, description, plain_text, and extracted_content and truncates to 28k chars", () => {
		expect(
			embedText({
				title: "Title",
				description: "Desc",
				plain_text: "Plain",
				extracted_content: "Extracted",
			}),
		).toBe("Title\n\nDesc\n\nPlain\n\nExtracted");

		expect(embedText({ title: "a".repeat(30_000) }).length).toBe(28_000);
	});
});

describe("embedEntityText", () => {
	it("joins title, description, scalar properties, and normalized aliases", () => {
		const text = embedEntityText({
			title: "Sam Altman",
			description: "Met at a conference.",
			properties: {
				role: "CEO",
				organization: "OpenAI",
				relationship: "acquaintance",
				expansion: "Expanded",
				context: "Context",
				aliases: ["Sam", "sam"],
			},
			aliases: ["S. Altman", "Sam"],
		});
		expect(text).toBe(
			"Sam Altman\n\nMet at a conference.\n\nCEO\n\nOpenAI\n\nacquaintance\n\nExpanded\n\nContext\n\nS. Altman Sam",
		);
	});

	it("returns empty string when nothing embeddable is present", () => {
		expect(embedEntityText({ title: null, description: null, properties: { email: "a@b.c" } })).toBe(
			"",
		);
	});
});

describe("classifyEmbeddingError and retryAfterMs", () => {
	it("classifies status codes and message patterns", () => {
		expect(classifyEmbeddingError(apiError(429))).toBe("rate_limit");
		expect(classifyEmbeddingError(apiError(401))).toBe("auth");
		expect(classifyEmbeddingError(apiError(403))).toBe("auth");
		expect(classifyEmbeddingError(apiError(400, "API_KEY_INVALID: API key not valid"))).toBe("auth");
		expect(classifyEmbeddingError(apiError(503))).toBe("transient");
		expect(classifyEmbeddingError(apiError(400, "invalid input"))).toBe("unknown");
		expect(classifyEmbeddingError(new Error("insufficient_quota"))).toBe("rate_limit");
		expect(classifyEmbeddingError(new Error("ECONNRESET"))).toBe("transient");
		expect(isRetryableEmbeddingError(apiError(429))).toBe(true);
		expect(isDegradableEmbeddingError(apiError(500))).toBe(true);
		expect(isRetryableEmbeddingError(apiError(401))).toBe(false);
		expect(isRetryableEmbeddingError(apiError(403))).toBe(false);
		expect(isDegradableEmbeddingError(apiError(401))).toBe(true);
		expect(isDegradableEmbeddingError(apiError(403))).toBe(true);
		expect(isDegradableEmbeddingError(apiError(400, "invalid input"))).toBe(false);
	});

	it("extracts and caps retry-after header values", () => {
		expect(retryAfterMs({ headers: { "retry-after": "2" } })).toBe(2000);
		expect(
			retryAfterMs({
				headers: { get: (name: string) => (name === "retry-after" ? "3" : null) },
			}),
		).toBe(3000);
		expect(retryAfterMs({ headers: { "retry-after": "3600" } })).toBe(60_000);
		expect(retryAfterMs(new Error("boom"))).toBeUndefined();
	});
});

describe("withEmbeddingRetry", () => {
	it("retries retryable errors and stops on non-retryable errors", async () => {
		const fn = vi
			.fn<() => Promise<number[]>>()
			.mockRejectedValueOnce(apiError(429))
			.mockResolvedValue([0.1, 0.2]);
		await expect(withEmbeddingRetry(fn, FAST)).resolves.toEqual([0.1, 0.2]);
		expect(fn).toHaveBeenCalledTimes(2);

		const authFn = vi.fn(async () => {
			throw apiError(401, "401 Unauthorized");
		});
		await expect(withEmbeddingRetry(authFn, FAST)).rejects.toThrow(/Unauthorized/);
		expect(authFn).toHaveBeenCalledTimes(1);
	});
});

describe("embedAndStore", () => {
	it("returns 'skipped' when port is null/disabled or text is empty", async () => {
		const store: EmbeddingStorePort = { setEmbedding: vi.fn() };
		const port: EmbeddingPort = {
			embed: vi.fn(async () => [0.1]),
			embedBatch: vi.fn(async () => [[0.1]]),
		};

		expect(await embedAndStore(null, store, "artifacts", "a1", { title: "Hello" })).toBe("skipped");
		expect(
			await embedAndStore(port, store, "artifacts", "a1", { title: "Hello" }, { enabled: false }),
		).toBe("skipped");
		expect(await embedAndStore(port, store, "artifacts", "a1", { title: null })).toBe("skipped");
		expect(
			await embedAndStore(port, store, "entities", "e1", {
				title: null,
				properties: { email: "x@example.com" },
			}),
		).toBe("skipped");
		expect(port.embed).not.toHaveBeenCalled();
		expect(store.setEmbedding).not.toHaveBeenCalled();
	});

	it("returns 'embedded' after withEmbeddingRetry + store.setEmbedding", async () => {
		const port: EmbeddingPort = {
			embed: vi
				.fn<(text: string) => Promise<number[]>>()
				.mockRejectedValueOnce(apiError(429))
				.mockResolvedValue([0.5, 0.6]),
			embedBatch: vi.fn(async () => []),
		};
		const store: EmbeddingStorePort = { setEmbedding: vi.fn(async () => undefined) };

		const outcome = await embedAndStore(
			port,
			store,
			"entities",
			"e1",
			{ title: "Sam", properties: { role: "CEO" } },
			{ retryOptions: FAST },
		);

		expect(outcome).toBe("embedded");
		expect(port.embed).toHaveBeenCalledTimes(2);
		expect(port.embed).toHaveBeenCalledWith("Sam\n\nCEO");
		expect(store.setEmbedding).toHaveBeenCalledWith("entities", "e1", [0.5, 0.6]);
	});

	it("returns 'failed' and never throws on a provider or store error", async () => {
		const onError = vi.fn();
		const failingPort: EmbeddingPort = {
			embed: vi.fn(async () => {
				throw apiError(401, "401 Invalid key");
			}),
			embedBatch: vi.fn(async () => []),
		};
		const store: EmbeddingStorePort = { setEmbedding: vi.fn(async () => undefined) };

		expect(
			await embedAndStore(
				failingPort,
				store,
				"artifacts",
				"a1",
				{ title: "Doc" },
				{ retryOptions: FAST, onError },
			),
		).toBe("failed");
		expect(onError).toHaveBeenCalledTimes(1);

		const okPort: EmbeddingPort = {
			embed: vi.fn(async () => [0.1]),
			embedBatch: vi.fn(async () => []),
		};
		const failingStore: EmbeddingStorePort = {
			setEmbedding: vi.fn(async () => {
				throw new Error("DB write failed");
			}),
		};
		expect(
			await embedAndStore(
				okPort,
				failingStore,
				"artifacts",
				"a2",
				{ title: "Doc" },
				{ retryOptions: FAST, onError },
			),
		).toBe("failed");
		expect(onError).toHaveBeenCalledTimes(2);
	});
});

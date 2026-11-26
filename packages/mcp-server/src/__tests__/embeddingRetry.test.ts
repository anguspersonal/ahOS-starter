import { describe, expect, it, vi } from "vitest";

import {
	classifyEmbeddingError,
	isDegradableEmbeddingError,
	isRetryableEmbeddingError,
	retryAfterMs,
} from "../embeddings/errors.js";
import { withEmbeddingRetry } from "../embeddings/retry.js";

// The classification + backoff layer behind every embedding call (#427, follow-up
// to the #486 quota outage). Pure units: no OpenAI client, no supabase, no env.
// All retries here run with a ~1ms base delay so real timers stay honest and fast.

const FAST = { baseDelayMs: 1 };

function apiError(status: number, message = `HTTP ${status}`): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

describe("classifyEmbeddingError — status codes", () => {
	it("classifies 429 as rate_limit", () => {
		expect(classifyEmbeddingError(apiError(429))).toBe("rate_limit");
	});

	it("classifies 401/403 as auth", () => {
		expect(classifyEmbeddingError(apiError(401))).toBe("auth");
		expect(classifyEmbeddingError(apiError(403))).toBe("auth");
	});

	it("classifies 5xx as transient", () => {
		expect(classifyEmbeddingError(apiError(500))).toBe("transient");
		expect(classifyEmbeddingError(apiError(503))).toBe("transient");
	});

	it("classifies other 4xx as unknown — a malformed request must not be retried", () => {
		expect(classifyEmbeddingError(apiError(400, "invalid input"))).toBe("unknown");
	});

	it("reads the status off a nested response object too", () => {
		expect(classifyEmbeddingError({ response: { status: 429 } })).toBe("rate_limit");
	});
});

describe("classifyEmbeddingError — message fallbacks", () => {
	it("recognises the #486 quota wording on a status-less error", () => {
		// This is the shape the outage actually surfaced through the tool layer.
		expect(classifyEmbeddingError(new Error("no credits remaining"))).toBe("rate_limit");
		expect(
			classifyEmbeddingError(new Error("429 You exceeded your current quota")),
		).toBe("rate_limit");
		expect(classifyEmbeddingError(new Error("insufficient_quota"))).toBe("rate_limit");
	});

	it("recognises auth failures on a status-less error", () => {
		expect(classifyEmbeddingError(new Error("OpenAI request failed: 401 Unauthorized"))).toBe(
			"auth",
		);
		expect(classifyEmbeddingError(new Error("Invalid API key provided"))).toBe("auth");
	});

	it("recognises network blips as transient", () => {
		expect(classifyEmbeddingError(new Error("ECONNRESET"))).toBe("transient");
		expect(classifyEmbeddingError(new Error("fetch failed"))).toBe("transient");
	});

	it("prefers auth over quota when a message mentions both — never retry a dead key", () => {
		expect(
			classifyEmbeddingError(new Error("401 Unauthorized — quota exceeded for this key")),
		).toBe("auth");
	});

	it("leaves anything unrecognised as unknown", () => {
		expect(classifyEmbeddingError(new Error("something odd happened"))).toBe("unknown");
		expect(classifyEmbeddingError(undefined)).toBe("unknown");
	});
});

describe("isRetryableEmbeddingError / isDegradableEmbeddingError", () => {
	it("retries and degrades on rate limits and transient failures", () => {
		for (const err of [apiError(429), apiError(500), new Error("ETIMEDOUT")]) {
			expect(isRetryableEmbeddingError(err)).toBe(true);
			expect(isDegradableEmbeddingError(err)).toBe(true);
		}
	});

	it("does not retry auth failures, but degrades on them (#1974)", () => {
		for (const err of [apiError(401), apiError(403)]) {
			expect(isRetryableEmbeddingError(err)).toBe(false);
			expect(isDegradableEmbeddingError(err)).toBe(true);
		}
	});

	it("does neither for unknown failures", () => {
		for (const err of [apiError(400), new Error("weird")]) {
			expect(isRetryableEmbeddingError(err)).toBe(false);
			expect(isDegradableEmbeddingError(err)).toBe(false);
		}
	});
});

describe("retryAfterMs", () => {
	it("reads a plain-object retry-after header (seconds -> ms)", () => {
		expect(retryAfterMs({ headers: { "retry-after": "2" } })).toBe(2000);
	});

	it("reads a Headers-like object (fetch Headers exposes get(), not indexing)", () => {
		const headers = { get: (name: string) => (name === "retry-after" ? "3" : null) };
		expect(retryAfterMs({ headers })).toBe(3000);
	});

	it("caps an absurd retry-after so one row cannot stall a batch for an hour", () => {
		expect(retryAfterMs({ headers: { "retry-after": "3600" } })).toBe(60_000);
	});

	it("returns undefined when absent or unparseable", () => {
		expect(retryAfterMs(new Error("boom"))).toBeUndefined();
		expect(retryAfterMs({ headers: { "retry-after": "soon" } })).toBeUndefined();
	});
});

describe("withEmbeddingRetry", () => {
	it("returns the first successful result without retrying", async () => {
		const fn = vi.fn(async () => [0.1]);
		await expect(withEmbeddingRetry(fn, FAST)).resolves.toEqual([0.1]);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries a 429 and succeeds on a later attempt", async () => {
		const fn = vi
			.fn<() => Promise<number[]>>()
			.mockRejectedValueOnce(apiError(429))
			.mockRejectedValueOnce(apiError(429))
			.mockResolvedValue([0.2]);

		await expect(withEmbeddingRetry(fn, { ...FAST, maxAttempts: 3 })).resolves.toEqual([0.2]);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("gives up after maxAttempts and re-throws the last error", async () => {
		const fn = vi.fn(async () => {
			throw apiError(429, "429 rate limit");
		});

		await expect(withEmbeddingRetry(fn, { ...FAST, maxAttempts: 3 })).rejects.toThrow(
			/rate limit/,
		);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("does not retry an auth failure — a revoked key fails on the first attempt", async () => {
		const fn = vi.fn(async () => {
			throw apiError(401, "401 Unauthorized");
		});

		await expect(withEmbeddingRetry(fn, { ...FAST, maxAttempts: 5 })).rejects.toThrow(
			/Unauthorized/,
		);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("reports each retry through onRetry with a growing delay", async () => {
		const onRetry = vi.fn();
		const fn = vi
			.fn<() => Promise<number[]>>()
			.mockRejectedValueOnce(apiError(500))
			.mockRejectedValueOnce(apiError(500))
			.mockResolvedValue([0.3]);

		await withEmbeddingRetry(fn, { baseDelayMs: 4, maxAttempts: 3, onRetry });

		expect(onRetry).toHaveBeenCalledTimes(2);
		const [first, second] = onRetry.mock.calls.map((c) => c[0]);
		expect(first.attempt).toBe(1);
		expect(second.attempt).toBe(2);
		// Jittered, so assert the window rather than an exact value: attempt 1 draws
		// from [0.4, 4]ms and attempt 2 from [0.8, 8]ms.
		expect(first.delayMs).toBeLessThanOrEqual(4);
		expect(second.delayMs).toBeLessThanOrEqual(8);
	});

	it("waits the provider's retry-after instead of its own backoff when one is given", async () => {
		const onRetry = vi.fn();
		const err = Object.assign(new Error("429 slow down"), {
			status: 429,
			headers: { "retry-after": "1" },
		});
		const fn = vi.fn<() => Promise<number[]>>().mockRejectedValueOnce(err).mockResolvedValue([0.4]);

		// 1s wait, so keep it to a single retry; the point is the value, not the wait.
		await withEmbeddingRetry(fn, { baseDelayMs: 1, maxAttempts: 2, onRetry });

		expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 1000 }));
	});
});

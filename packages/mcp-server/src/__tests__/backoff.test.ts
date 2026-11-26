import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	httpRetryAfterMs,
	httpStatusOf,
	isRetryableHttpError,
	withBackoff,
} from "../backoff.js";

// The shared 429/5xx backoff helper behind the discover-cadence pagination loops
// (#472 Notion + Drive, #474) and — via withEmbeddingRetry — every embedding call.
// All timing runs on fake timers: the suite never actually sleeps.

function httpError(status: number, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Run `withBackoff`, flushing fake timers until the promise settles. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
	// Capture rejection immediately so an exhausted retry never surfaces as an
	// unhandled rejection while timers are being flushed.
	const outcome = promise.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	await vi.runAllTimersAsync();
	return outcome;
}

describe("httpStatusOf", () => {
	it("reads status, statusCode, nested response.status, and numeric-string code", () => {
		expect(httpStatusOf({ status: 429 })).toBe(429);
		expect(httpStatusOf({ statusCode: 503 })).toBe(503);
		expect(httpStatusOf({ response: { status: 500 } })).toBe(500);
		expect(httpStatusOf({ code: "429" })).toBe(429);
	});

	it("ignores non-HTTP codes and statusless errors", () => {
		expect(httpStatusOf({ code: "ECONNRESET" })).toBeUndefined();
		expect(httpStatusOf(new Error("boom"))).toBeUndefined();
		expect(httpStatusOf(undefined)).toBeUndefined();
	});
});

describe("isRetryableHttpError", () => {
	it("retries 429 and 5xx", () => {
		expect(isRetryableHttpError(httpError(429))).toBe(true);
		expect(isRetryableHttpError(httpError(500))).toBe(true);
		expect(isRetryableHttpError({ response: { status: 503 } })).toBe(true);
	});

	it("does not retry other 4xx or statusless errors", () => {
		expect(isRetryableHttpError(httpError(400))).toBe(false);
		expect(isRetryableHttpError(httpError(401))).toBe(false);
		expect(isRetryableHttpError(httpError(403))).toBe(false);
		expect(isRetryableHttpError(new Error("fetch failed"))).toBe(false);
	});
});

describe("httpRetryAfterMs", () => {
	it("parses delta-seconds off a plain-object header", () => {
		expect(httpRetryAfterMs({ headers: { "retry-after": "2" } })).toBe(2000);
	});

	it("parses delta-seconds off a fetch Headers instance", () => {
		expect(httpRetryAfterMs({ headers: new Headers({ "retry-after": "3" }) })).toBe(3000);
	});

	it("reads gaxios-style nested response.headers", () => {
		expect(httpRetryAfterMs({ response: { headers: { "retry-after": "1" } } })).toBe(1000);
	});

	it("parses the HTTP-date form relative to now", () => {
		vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));
		expect(
			httpRetryAfterMs({ headers: { "retry-after": "Wed, 05 Aug 2026 12:00:05 GMT" } }),
		).toBe(5000);
	});

	it("returns undefined for an HTTP-date already in the past", () => {
		vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));
		expect(
			httpRetryAfterMs({ headers: { "retry-after": "Wed, 05 Aug 2026 11:59:00 GMT" } }),
		).toBeUndefined();
	});

	it("caps an absurd ask so one throttled page cannot stall a cadence for an hour", () => {
		expect(httpRetryAfterMs({ headers: { "retry-after": "3600" } })).toBe(60_000);
	});

	it("returns undefined when absent or unparseable", () => {
		expect(httpRetryAfterMs(new Error("boom"))).toBeUndefined();
		expect(httpRetryAfterMs({ headers: { "retry-after": "soon" } })).toBeUndefined();
		expect(httpRetryAfterMs({ headers: { "retry-after": "0" } })).toBeUndefined();
	});
});

describe("withBackoff", () => {
	it("returns the first successful result without retrying", async () => {
		const fn = vi.fn(async () => "ok");
		const { value } = await settle(withBackoff(fn));
		expect(value).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("waits exactly the server's Retry-After on a 429 that carries one", async () => {
		const onRetry = vi.fn();
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(httpError(429, { headers: { "retry-after": "2" } }))
			.mockResolvedValue("ok");

		const promise = withBackoff(fn, { onRetry });

		// Flush microtasks: the first attempt fails and the 2s pause is scheduled.
		await vi.advanceTimersByTimeAsync(0);
		expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 2000 }));

		// Just short of the requested wait: no second attempt yet.
		await vi.advanceTimersByTimeAsync(1999);
		expect(fn).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		await expect(promise).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("falls back to jittered exponential backoff on a 429 without Retry-After", async () => {
		// Pin jitter to the top of the window so the doubling is observable exactly.
		vi.spyOn(Math, "random").mockReturnValue(1);
		const onRetry = vi.fn();
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(httpError(429))
			.mockRejectedValueOnce(httpError(429))
			.mockResolvedValue("ok");

		const { value } = await settle(withBackoff(fn, { baseDelayMs: 500, onRetry }));

		expect(value).toBe("ok");
		expect(onRetry).toHaveBeenCalledTimes(2);
		const [first, second] = onRetry.mock.calls.map((c) => c[0]);
		expect(first).toMatchObject({ attempt: 1, delayMs: 500 });
		expect(second).toMatchObject({ attempt: 2, delayMs: 1000 });
	});

	it("caps a single computed pause at maxDelayMs", async () => {
		vi.spyOn(Math, "random").mockReturnValue(1);
		const onRetry = vi.fn();
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(httpError(500))
			.mockResolvedValue("ok");

		await settle(withBackoff(fn, { baseDelayMs: 500, maxDelayMs: 250, onRetry }));

		expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 250 }));
	});

	it("retries transient 5xx failures, including the gaxios nested-status shape", async () => {
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(Object.assign(new Error("backend error"), { response: { status: 503 } }))
			.mockResolvedValue("ok");

		const { value } = await settle(withBackoff(fn, { baseDelayMs: 1 }));

		expect(value).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does not retry a non-429 4xx — the original error surfaces immediately", async () => {
		const original = httpError(400, { headers: { "retry-after": "1" } });
		const fn = vi.fn(async () => {
			throw original;
		});

		const { error } = await settle(withBackoff(fn));

		expect(error).toBe(original);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("rethrows the original error once attempts are exhausted", async () => {
		const original = httpError(429);
		const fn = vi.fn(async () => {
			throw original;
		});

		const { error } = await settle(withBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 }));

		expect(error).toBe(original);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("logs each retry through console.warn by default so backoff is visible", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(httpError(429))
			.mockResolvedValue("ok");

		await settle(withBackoff(fn, { baseDelayMs: 1, label: "notion /v1/search" }));

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toMatch(/notion \/v1\/search: retryable failure on attempt 1\/4/);
	});

	it("honours a custom isRetryable predicate", async () => {
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("flaky"))
			.mockResolvedValue("ok");

		const { value } = await settle(
			withBackoff(fn, { baseDelayMs: 1, isRetryable: () => true, onRetry: () => {} }),
		);

		expect(value).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

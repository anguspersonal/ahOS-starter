// Bounded exponential backoff for external HTTP calls (#472 / #474).
//
// Generalised out of embeddings/retry.ts (#427), which carried the package's only
// retry loop but hard-wired an embedding-provider error classifier. The loop now
// lives here, parameterised by a retryability predicate and a Retry-After
// extractor: withEmbeddingRetry delegates to withBackoff with its own classifier,
// and the discover-cadence pagination loops (Notion /v1/search via notion.ts,
// Drive files.list via schedule/driveDiscoverCadence.ts) use the HTTP defaults
// below — retry on 429 and 5xx only, never on other 4xx.
//
// Deliberately dependency-free (no env/supabase/client imports) so it is
// unit-testable in isolation and importable from anywhere in the package.

export type BackoffOptions = {
	/** Total attempts including the first. Default 4 (i.e. up to 3 retries). */
	maxAttempts?: number;
	/** First backoff pause; doubles each retry. Default 500ms. */
	baseDelayMs?: number;
	/** Upper bound on any single computed pause. Default 30s. */
	maxDelayMs?: number;
	/** Which failures are worth retrying. Default: HTTP 429 or 5xx (`isRetryableHttpError`). */
	isRetryable?: (err: unknown) => boolean;
	/**
	 * Server-requested wait, if the error carries one. Default reads a Retry-After
	 * header (seconds or HTTP-date) off `err.headers` / `err.response.headers`.
	 */
	retryAfterMs?: (err: unknown) => number | undefined;
	/** Called before each pause. Default: console.warn a line naming `label`. */
	onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
	/** Names the operation in the default retry log line, e.g. "notion /v1/search". */
	label?: string;
};

const DEFAULTS = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000 } as const;

// A server may legitimately ask for a long Retry-After; cap it so one throttled
// page cannot stall a scheduled cadence for an hour.
const RETRY_AFTER_CAP_MS = 60_000;

/** Promise-based sleep; exported for callers pacing between calls (inter-page delays). */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP status carried by an error, wherever the client put it: a plain `status`
 * (our own fetch wrappers, OpenAI SDK), `statusCode`, a nested `response.status`
 * (googleapis/gaxios), or a numeric-string `code` (older gaxios).
 */
export function httpStatusOf(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const e = err as {
		status?: unknown;
		statusCode?: unknown;
		code?: unknown;
		response?: { status?: unknown };
	};
	const candidates = [e.status, e.statusCode, e.response?.status];
	for (const c of candidates) {
		if (typeof c === "number" && Number.isFinite(c)) return c;
	}
	if (typeof e.code === "string" && /^\d{3}$/.test(e.code)) return Number(e.code);
	return undefined;
}

/**
 * Default retryability: 429 (rate limit) and 5xx (transient server failure).
 * Any other 4xx is a request-shape or auth problem — retrying cannot fix it —
 * and a status-less error is not confidently transient, so neither is retried.
 */
export function isRetryableHttpError(err: unknown): boolean {
	const status = httpStatusOf(err);
	return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

/** Read the Retry-After value off a fetch `Headers` instance or a plain object. */
function retryAfterHeader(headers: unknown): unknown {
	if (typeof headers !== "object" || headers === null) return undefined;
	// Duck-typed rather than referencing the DOM `Headers` type: clients hand back
	// either a fetch Headers instance or a plain object depending on the transport.
	const get = (headers as { get?: (name: string) => unknown }).get;
	if (typeof get === "function") return get.call(headers, "retry-after");
	const h = headers as Record<string, unknown>;
	return h["retry-after"] ?? h["Retry-After"];
}

/**
 * Milliseconds requested by a `Retry-After` header, if the error carries one on
 * `err.headers` (fetch wrappers) or `err.response.headers` (gaxios). Understands
 * both delta-seconds ("2") and HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT") forms;
 * returns undefined when absent, unparseable, or already in the past.
 *
 * Deliberate: a `Retry-After: 0` (or a past HTTP-date) also returns undefined,
 * so the caller falls through to the computed jittered backoff instead of
 * retrying immediately — "retry now" from a server that just rate-limited us
 * is not worth honouring literally. Don't "fix" this into an instant retry.
 */
export function httpRetryAfterMs(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const e = err as { headers?: unknown; response?: { headers?: unknown } };
	const raw = retryAfterHeader(e.headers) ?? retryAfterHeader(e.response?.headers);
	if (raw === undefined || raw === null) return undefined;

	const seconds = Number(raw);
	if (Number.isFinite(seconds)) {
		if (seconds <= 0) return undefined;
		return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
	}

	const at = Date.parse(String(raw));
	if (!Number.isFinite(at)) return undefined;
	const deltaMs = at - Date.now();
	if (deltaMs <= 0) return undefined;
	return Math.min(deltaMs, RETRY_AFTER_CAP_MS);
}

/**
 * Run `fn`, retrying only failures `isRetryable` accepts. Backoff is exponential
 * with floored full jitter (spreading concurrent retries rather than synchronising
 * them into another burst), and a server-sent Retry-After wins over the computed pause
 * when present. Re-throws the last error once attempts are exhausted, so the
 * caller still decides what a definitive failure means.
 */
export async function withBackoff<T>(fn: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULTS.maxAttempts);
	const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
	const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
	const isRetryable = options.isRetryable ?? isRetryableHttpError;
	const retryAfterMs = options.retryAfterMs ?? httpRetryAfterMs;
	const label = options.label ?? "http call";
	const onRetry =
		options.onRetry ??
		(({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: unknown }) => {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`${label}: retryable failure on attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms: ${message}`,
			);
		});

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (attempt === maxAttempts || !isRetryable(err)) throw err;

			const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
			// Full jitter WITH A FLOOR: uniform over [backoff/10, backoff], not the
			// classic uniform [0, backoff] — the floor keeps a retry from ever
			// effectively becoming an immediate re-fire.
			const jittered = Math.max(backoff / 10, Math.random() * backoff);
			const delayMs = retryAfterMs(err) ?? Math.round(jittered);
			onRetry({ attempt, delayMs, error: err });
			await sleep(delayMs);
		}
	}
	throw lastError;
}

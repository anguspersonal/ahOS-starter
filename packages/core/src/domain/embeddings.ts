/**
 * Pure domain helpers for embeddings: text composition, error classification,
 * exponential backoff retry, and best-effort embedAndStore (#1615, ADR-047, ADR-101).
 */

import type {
	EmbeddableTable,
	EmbeddingPort,
	EmbeddingStorePort,
} from "../ports/embeddings.js";

const MAX_CHARS = 28_000;
const RETRY_AFTER_CAP_MS = 60_000;
const RETRY_DEFAULTS = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000 } as const;

export type EmbedFields = {
	title?: string | null;
	description?: string | null;
	plain_text?: string | null;
	extracted_content?: string | null;
};

export type EmbeddableFields = EmbedFields;

export type EntityEmbedFields = {
	title?: string | null;
	description?: string | null;
	properties?: Record<string, unknown> | null;
	aliases?: readonly string[] | null;
};

export type EntityEmbeddableFields = EntityEmbedFields;

export type EmbedAndStoreOutcome =
	/** Vector computed and written to the row's embedding column. */
	| "embedded"
	/** Nothing to do: no port/key configured, disabled, or no embeddable text. */
	| "skipped"
	/** Provider or DB error -- reported via onError, swallowed, row left untouched. */
	| "failed";

export type EmbedOutcome = EmbedAndStoreOutcome;

/** Trim, drop blanks, dedupe case-insensitively; the first spelling seen wins. */
function normalizeAliases(values: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

/** Every alias a row carries: the column first, then the legacy jsonb array. */
function collectAliases(row: {
	aliases?: readonly string[] | null;
	properties?: Record<string, unknown> | null;
}): string[] {
	const legacy = row.properties?.aliases;
	return normalizeAliases([...(row.aliases ?? []), ...(Array.isArray(legacy) ? legacy : [])]);
}

/**
 * The text an artifact is embedded from. Mirrors the fields the FTS `search_vector`
 * generated column is built from (migration 044: title + plain_text +
 * extracted_content + description) so the two arms of hybrid search see the same
 * text.
 */
export function embedText(a: EmbedFields): string {
	return [a.title, a.description, a.plain_text, a.extracted_content]
		.filter(Boolean)
		.join("\n\n")
		.slice(0, MAX_CHARS)
		.trim();
}

/**
 * The text an `entities` row is embedded from (ADR-047 section 1/2, #551, #1153). Mirrors
 * the fields migration 125's generated `search_vector` is built from:
 * title + description + properties.{role,organization,relationship,expansion,context}
 * + aliases.
 */
export function embedEntityText(e: EntityEmbedFields): string {
	const props = e.properties ?? {};
	const role = typeof props.role === "string" ? props.role : null;
	const organization = typeof props.organization === "string" ? props.organization : null;
	const relationship = typeof props.relationship === "string" ? props.relationship : null;
	const expansion = typeof props.expansion === "string" ? props.expansion : null;
	const context = typeof props.context === "string" ? props.context : null;
	const aliases = collectAliases(e).join(" ");
	return [e.title, e.description, role, organization, relationship, expansion, context, aliases]
		.filter(Boolean)
		.join("\n\n")
		.slice(0, MAX_CHARS)
		.trim();
}

export type EmbeddingErrorKind =
	/** 429 / quota exhausted -- retryable, and a legitimate reason to degrade search. */
	| "rate_limit"
	/** 5xx, timeout, connection reset -- retryable. */
	| "transient"
	/** 401/403, missing or revoked key -- never retryable; search degrades to FTS. */
	| "auth"
	/** Anything we cannot confidently place. Treated as non-retryable, must surface. */
	| "unknown";

function httpStatusOf(err: unknown): number | undefined {
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

function retryAfterHeader(headers: unknown): unknown {
	if (typeof headers !== "object" || headers === null) return undefined;
	const get = (headers as { get?: (name: string) => unknown }).get;
	if (typeof get === "function") return get.call(headers, "retry-after");
	const h = headers as Record<string, unknown>;
	return h["retry-after"] ?? h["Retry-After"];
}

function httpRetryAfterMs(err: unknown): number | undefined {
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

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (typeof err === "object" && err !== null) {
		const m = (err as { message?: unknown }).message;
		if (typeof m === "string") return m;
	}
	return String(err);
}

const RATE_LIMIT_PATTERNS = [
	/\b429\b/,
	/rate.?limit/i,
	/insufficient_quota/i,
	/exceeded your current quota/i,
	/no credits remaining/i,
	/too many requests/i,
];

const AUTH_PATTERNS = [
	/\b401\b/,
	/\b403\b/,
	/unauthorized/i,
	/forbidden/i,
	/invalid.?api.?key/i,
	/api_key_invalid/i,
	/api key not valid/i,
];

const TRANSIENT_PATTERNS = [
	/\b5\d{2}\b/,
	/econnreset/i,
	/econnrefused/i,
	/etimedout/i,
	/socket hang up/i,
	/network/i,
	/fetch failed/i,
	/timeout/i,
];

/**
 * Bucket an embedding-provider failure. Status code wins when present; otherwise
 * the message is pattern-matched. Unrecognised failures stay `"unknown"`.
 */
export function classifyEmbeddingError(err: unknown): EmbeddingErrorKind {
	const status = httpStatusOf(err);
	if (status === 429) return "rate_limit";
	if (status === 401 || status === 403) return "auth";
	if (status !== undefined && status >= 500) return "transient";

	const message = messageOf(err);
	if (AUTH_PATTERNS.some((re) => re.test(message))) return "auth";
	if (status !== undefined && status >= 400) return "unknown";

	if (RATE_LIMIT_PATTERNS.some((re) => re.test(message))) return "rate_limit";
	if (TRANSIENT_PATTERNS.some((re) => re.test(message))) return "transient";
	return "unknown";
}

/** Whether backing off and trying again could plausibly succeed. */
export function isRetryableEmbeddingError(err: unknown): boolean {
	const kind = classifyEmbeddingError(err);
	return kind === "rate_limit" || kind === "transient";
}

/**
 * Whether search should fall back to full-text rather than failing the query.
 * Auth errors (401/403/invalid key) degrade search to FTS while remaining
 * non-retryable so backoff loops and backfill circuit-breakers do not hammer a rejected key.
 */
export function isDegradableEmbeddingError(err: unknown): boolean {
	const kind = classifyEmbeddingError(err);
	return kind === "rate_limit" || kind === "transient" || kind === "auth";
}

/**
 * Milliseconds requested by a `retry-after` response header, if the error carries
 * one (capped at 60s).
 */
export function retryAfterMs(err: unknown): number | undefined {
	return httpRetryAfterMs(err);
}

export type RetryOptions = {
	/** Total attempts including the first. Default 3 (i.e. up to 2 retries). */
	maxAttempts?: number;
	/** First backoff pause; doubles each retry. Default 500ms. */
	baseDelayMs?: number;
	/** Upper bound on any single pause. Default 30s. */
	maxDelayMs?: number;
	/** Called before each pause -- used for progress logging in long-running jobs. */
	onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn`, retrying only failures `isRetryableEmbeddingError` accepts. Backoff is
 * exponential with floored full jitter, and honours a `retry-after` header when
 * the provider sends one. Re-throws the last error once attempts are exhausted.
 */
export async function withEmbeddingRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const maxAttempts = Math.max(1, options.maxAttempts ?? RETRY_DEFAULTS.maxAttempts);
	const baseDelayMs = options.baseDelayMs ?? RETRY_DEFAULTS.baseDelayMs;
	const maxDelayMs = options.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs;
	const onRetry =
		options.onRetry ??
		(({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: unknown }) => {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`embedding call: retryable failure on attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms: ${message}`,
			);
		});

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (attempt === maxAttempts || !isRetryableEmbeddingError(err)) throw err;

			const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
			const jittered = Math.max(backoff / 10, Math.random() * backoff);
			const delayMs = retryAfterMs(err) ?? Math.round(jittered);
			onRetry({ attempt, delayMs, error: err });
			await sleep(delayMs);
		}
	}
	throw lastError;
}

export interface EmbedAndStoreOptions {
	enabled?: boolean;
	retryOptions?: RetryOptions;
	onError?: (err: unknown) => void;
}

/**
 * Best-effort: build the embed text, call the embedding port (with backoff on
 * 429/5xx), write to the store. Never throws.
 */
export async function embedAndStore(
	port: EmbeddingPort | null | undefined,
	store: EmbeddingStorePort,
	table: EmbeddableTable,
	id: string,
	fields: EmbedFields | EntityEmbedFields,
	options?: EmbedAndStoreOptions,
): Promise<EmbedAndStoreOutcome> {
	if (!port || options?.enabled === false) return "skipped";
	const text =
		table === "entities"
			? embedEntityText(fields as EntityEmbedFields)
			: embedText(fields as EmbedFields);
	if (!text) return "skipped";
	try {
		const vector = await withEmbeddingRetry(() => port.embed(text), options?.retryOptions);
		await store.setEmbedding(table, id, vector);
		return "embedded";
	} catch (err) {
		options?.onError?.(err);
		return "failed";
	}
}

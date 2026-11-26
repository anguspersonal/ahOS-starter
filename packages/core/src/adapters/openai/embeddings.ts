/**
 * Fetch-based OpenAI embeddings adapter (#1615, ADR-047, ADR-101 section 3).
 *
 * Uses global fetch (or an injected fetchFn) with zero vendor SDK dependencies.
 */

import type { EmbeddingPort } from "../../ports/embeddings.js";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_CHARS = 28_000;
const MIN_RETRY_CHARS = 1_000;

export interface OpenAiEmbeddingAdapterConfig {
	apiKey: string | undefined | (() => string | undefined);
	model?: string | (() => string | undefined);
	baseUrl?: string;
	fetchFn?: typeof fetch;
}

type OpenAiEmbeddingItem = {
	embedding?: number[];
	index?: number;
};

type OpenAiEmbeddingResponse = {
	data?: OpenAiEmbeddingItem[];
	error?: {
		message?: string;
	};
};

function resolveString(value: string | undefined | (() => string | undefined)): string | undefined {
	return typeof value === "function" ? value() : value;
}

function redactSecret(text: string, secret: string): string {
	if (!secret) return text;
	return text.split(secret).join("[REDACTED]");
}

function isContextLengthError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const status = (err as { status?: unknown }).status;
	if (typeof status === "number" && status !== 400) return false;
	return /maximum context length|too many tokens/i.test(err.message);
}

async function readResponsePayload(
	res: Response,
): Promise<{ parsed: OpenAiEmbeddingResponse | undefined; rawText: string }> {
	if (typeof res.text === "function") {
		const rawText = await res.text();
		if (!rawText) return { parsed: undefined, rawText: "" };
		try {
			return { parsed: JSON.parse(rawText) as OpenAiEmbeddingResponse, rawText };
		} catch {
			return { parsed: undefined, rawText };
		}
	}
	if (typeof res.json === "function") {
		const parsed = (await res.json()) as OpenAiEmbeddingResponse;
		return {
			parsed,
			rawText: typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? {}),
		};
	}
	return { parsed: undefined, rawText: "" };
}

export function createOpenAiEmbeddingAdapter(
	config: OpenAiEmbeddingAdapterConfig,
): EmbeddingPort {
	const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

	async function postEmbeddings(input: string | string[]): Promise<OpenAiEmbeddingResponse> {
		const apiKey = resolveString(config.apiKey)?.trim();
		if (!apiKey) {
			throw new Error("OPENAI_API_KEY not set -- embeddings disabled.");
		}
		const model = resolveString(config.model)?.trim() || DEFAULT_MODEL;
		const fetchImpl = config.fetchFn ?? globalThis.fetch;

		let res: Response;
		try {
			res = await fetchImpl(`${baseUrl}/embeddings`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ model, input }),
			});
		} catch (err) {
			if (err instanceof Error && err.message.includes(apiKey)) {
				err.message = redactSecret(err.message, apiKey);
			}
			throw err;
		}

		const { parsed, rawText } = await readResponsePayload(res);

		if (!res.ok) {
			const apiMessage =
				typeof parsed?.error?.message === "string" && parsed.error.message.trim()
					? parsed.error.message.trim()
					: rawText.trim() || `HTTP ${res.status}`;
			const safeMessage = redactSecret(apiMessage, apiKey);
			const err = Object.assign(new Error(`${res.status} ${safeMessage}`), {
				status: res.status,
				headers: res.headers,
			});
			throw err;
		}

		if (!parsed || !Array.isArray(parsed.data)) {
			throw new Error("OpenAI embeddings response did not include a valid data array.");
		}

		return parsed;
	}

	return {
		async embed(text: string): Promise<number[]> {
			if (!text.trim()) {
				throw new Error("Empty text -- cannot generate embedding.");
			}
			let input = text.slice(0, MAX_CHARS);
			for (;;) {
				try {
					const res = await postEmbeddings(input);
					const vector = res.data?.[0]?.embedding;
					if (!Array.isArray(vector)) {
						throw new Error("OpenAI embeddings response did not include a valid embedding vector.");
					}
					return vector;
				} catch (err) {
					if (!isContextLengthError(err) || input.length <= MIN_RETRY_CHARS) {
						throw err;
					}
					input = input.slice(0, Math.floor(input.length / 2));
				}
			}
		},

		async embedBatch(texts: string[]): Promise<number[][]> {
			if (texts.length === 0) return [];
			const res = await postEmbeddings(texts.map((t) => t.slice(0, MAX_CHARS)));
			const vectors = new Array<number[] | undefined>(texts.length);
			for (const item of res.data ?? []) {
				if (typeof item.index === "number" && Array.isArray(item.embedding)) {
					vectors[item.index] = item.embedding;
				}
			}
			const missing = vectors.findIndex((v) => v === undefined);
			if (missing !== -1) {
				throw new Error(`embedding batch returned no vector for input ${missing}`);
			}
			return vectors as number[][];
		},
	};
}

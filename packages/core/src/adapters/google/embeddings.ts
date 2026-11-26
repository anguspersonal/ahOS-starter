/**
 * Fetch-based Google Gemini embeddings adapter (#1974, ADR-047, ADR-101 section 3).
 *
 * Uses global fetch (or an injected fetchFn) with zero vendor SDK dependencies.
 * Default model: `gemini-embedding-001` with `outputDimensionality: 1536` to match
 * pgvector `vector(1536)` columns.
 */

import type { EmbeddingPort } from "../../ports/embeddings.js";

const DEFAULT_MODEL = "gemini-embedding-001";
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MAX_CHARS = 28_000;
const MIN_RETRY_CHARS = 1_000;

export interface GeminiEmbeddingConfig {
	apiKey: string | undefined | (() => string | undefined);
	model?: string | (() => string | undefined);
	outputDimensionality?: number | (() => number | undefined);
	dimensions?: number | (() => number | undefined);
	baseUrl?: string;
	fetchFn?: typeof fetch;
}

export type GeminiEmbeddingAdapterConfig = GeminiEmbeddingConfig;

type GeminiEmbeddingValue = {
	values?: number[];
};

type GeminiEmbedResponse = {
	embedding?: GeminiEmbeddingValue;
	embeddings?: GeminiEmbeddingValue[];
	error?: {
		code?: number;
		message?: string;
		status?: string;
	};
};

function resolveString(value: string | undefined | (() => string | undefined)): string | undefined {
	return typeof value === "function" ? value() : value;
}

function resolveNumber(value: number | undefined | (() => number | undefined)): number | undefined {
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
	return /maximum context length|too many tokens|token limit|payload size exceeds|exceeds the maximum/i.test(
		err.message,
	);
}

async function readResponsePayload(
	res: Response,
): Promise<{ parsed: GeminiEmbedResponse | undefined; rawText: string }> {
	if (typeof res.text === "function") {
		const rawText = await res.text();
		if (!rawText) return { parsed: undefined, rawText: "" };
		try {
			return { parsed: JSON.parse(rawText) as GeminiEmbedResponse, rawText };
		} catch {
			return { parsed: undefined, rawText };
		}
	}
	if (typeof res.json === "function") {
		const parsed = (await res.json()) as GeminiEmbedResponse;
		return {
			parsed,
			rawText: typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? {}),
		};
	}
	return { parsed: undefined, rawText: "" };
}

export function createGeminiEmbeddingAdapter(config: GeminiEmbeddingConfig): EmbeddingPort {
	const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

	function resolveConfig(): { apiKey: string; bareModel: string; modelResource: string; dimensions: number } {
		const apiKey = resolveString(config.apiKey)?.trim();
		if (!apiKey) {
			throw new Error("GEMINI_API_KEY not set -- embeddings disabled.");
		}
		const rawModel = resolveString(config.model)?.trim() || DEFAULT_MODEL;
		const bareModel = rawModel.replace(/^models\//, "");
		const modelResource = `models/${bareModel}`;
		const dimensions =
			resolveNumber(config.outputDimensionality) ??
			resolveNumber(config.dimensions) ??
			DEFAULT_DIMENSIONS;
		return { apiKey, bareModel, modelResource, dimensions };
	}

	async function postJson(endpoint: string, body: unknown, apiKey: string): Promise<GeminiEmbedResponse> {
		const fetchImpl = config.fetchFn ?? globalThis.fetch;

		let res: Response;
		try {
			res = await fetchImpl(endpoint, {
				method: "POST",
				headers: {
					"x-goog-api-key": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
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

		if (!parsed || typeof parsed !== "object") {
			throw new Error("Gemini embeddings response did not include a valid JSON payload.");
		}

		return parsed;
	}

	return {
		async embed(text: string): Promise<number[]> {
			if (!text.trim()) {
				throw new Error("Empty text -- cannot generate embedding.");
			}
			const { apiKey, bareModel, modelResource, dimensions } = resolveConfig();
			const endpoint = `${baseUrl}/models/${bareModel}:embedContent`;
			let input = text.slice(0, MAX_CHARS);
			for (;;) {
				try {
					const res = await postJson(
						endpoint,
						{
							model: modelResource,
							content: { parts: [{ text: input }] },
							outputDimensionality: dimensions,
						},
						apiKey,
					);
					const vector = res.embedding?.values;
					if (!Array.isArray(vector)) {
						throw new Error("Gemini embeddings response did not include a valid embedding vector.");
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
			const { apiKey, bareModel, modelResource, dimensions } = resolveConfig();
			const endpoint = `${baseUrl}/models/${bareModel}:batchEmbedContents`;
			const requests = texts.map((t) => ({
				model: modelResource,
				content: { parts: [{ text: t.slice(0, MAX_CHARS) }] },
				outputDimensionality: dimensions,
			}));
			const res = await postJson(endpoint, { requests }, apiKey);
			if (!Array.isArray(res.embeddings)) {
				throw new Error("Gemini batch embeddings response did not include an embeddings array.");
			}
			const vectors: number[][] = [];
			for (let i = 0; i < texts.length; i += 1) {
				const values = res.embeddings[i]?.values;
				if (!Array.isArray(values)) {
					throw new Error(`embedding batch returned no vector for input ${i}`);
				}
				vectors.push(values);
			}
			return vectors;
		},
	};
}

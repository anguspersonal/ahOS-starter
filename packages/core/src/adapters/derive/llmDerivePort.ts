/**
 * @ahkms/core/adapters - LLM provider port for entity derivation (ADR-101 §3, #1306).
 *
 * Uses the official provider SDKs (`@google/genai`, `@anthropic-ai/sdk`). API
 * keys are passed as SDK credentials (request headers), never in a URL. All
 * configuration is explicit: this module reads no environment variables; the
 * composition root passes the keys and model names in.
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { DeriveLlmRequest, DeriveLlmResponse } from "../../actions/domain/derivePorts.js";

/** Retired `claude-3-5-haiku-20241022` replaced per #1306 H5. */
export const DEFAULT_DERIVE_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_DERIVE_GEMINI_MODEL = "gemini-2.5-flash";
export const FALLBACK_DERIVE_GEMINI_MODEL = "gemini-3.8-flash";
const MAX_OUTPUT_TOKENS = 4096;

function isNewUserModelUnavailableError(err: unknown, model: string): boolean {
	if (model === FALLBACK_DERIVE_GEMINI_MODEL) return false;
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("no longer available to new users") || msg.includes("gemini-3.8-flash");
}

export interface DeriveLlmConfig {
	geminiApiKey?: string;
	anthropicApiKey?: string;
	defaultProvider?: "gemini" | "anthropic";
	geminiModel?: string;
	anthropicModel?: string;
}

/** Minimal structural views of the SDK clients, so tests can inject fakes. */
export interface GeminiLike {
	models: {
		generateContent(args: {
			model: string;
			contents: string;
			config?: Record<string, unknown>;
		}): Promise<{ text?: string }>;
	};
}

export interface AnthropicLike {
	messages: {
		create(args: {
			model: string;
			max_tokens: number;
			system: string;
			messages: Array<{ role: "user"; content: string }>;
		}): Promise<{ content: Array<{ type: string; text?: string }> }>;
	};
}

export interface DeriveLlmClients {
	gemini?: GeminiLike;
	anthropic?: AnthropicLike;
}

export function createDeriveLlmPort(
	config: DeriveLlmConfig,
	clients: DeriveLlmClients = {},
): (request: DeriveLlmRequest) => Promise<DeriveLlmResponse> {
	if (!config.geminiApiKey && !config.anthropicApiKey && !clients.gemini && !clients.anthropic) {
		throw new Error("Entity derivation needs GEMINI_API_KEY or ANTHROPIC_API_KEY");
	}

	let gemini = clients.gemini;
	let anthropic = clients.anthropic;
	const getGemini = (): GeminiLike => {
		if (gemini) return gemini;
		if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY not set");
		gemini = new GoogleGenAI({ apiKey: config.geminiApiKey }) as unknown as GeminiLike;
		return gemini;
	};
	const getAnthropic = (): AnthropicLike => {
		if (anthropic) return anthropic;
		if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY not set");
		anthropic = new Anthropic({ apiKey: config.anthropicApiKey }) as unknown as AnthropicLike;
		return anthropic;
	};

	const hasGemini = Boolean(config.geminiApiKey || clients.gemini);
	const hasAnthropic = Boolean(config.anthropicApiKey || clients.anthropic);

	return async (request) => {
		let provider = request.provider ?? config.defaultProvider ?? "gemini";
		let model = request.model;
		// Without an explicit provider request, fall back to whichever key exists.
		if (!request.provider) {
			if (provider === "gemini" && !hasGemini && hasAnthropic) {
				provider = "anthropic";
				model = undefined;
			} else if (provider === "anthropic" && !hasAnthropic && hasGemini) {
				provider = "gemini";
				model = undefined;
			}
		}

		if (provider === "gemini") {
			let resolved = model ?? config.geminiModel ?? DEFAULT_DERIVE_GEMINI_MODEL;
			const callGemini = (targetModel: string, disableThinking = false) =>
				getGemini().models.generateContent({
					model: targetModel,
					contents: request.prompt,
					config: {
						systemInstruction: request.system,
						responseMimeType: "application/json",
						maxOutputTokens: MAX_OUTPUT_TOKENS,
						...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
					},
				});
			let res: { text?: string };
			try {
				res = await callGemini(resolved);
			} catch (err) {
				if (!isNewUserModelUnavailableError(err, resolved)) {
					throw err;
				}
				resolved = FALLBACK_DERIVE_GEMINI_MODEL;
				res = await callGemini(resolved, true);
			}
			return { text: res.text ?? "", provider: "gemini", model: resolved };
		}

		const resolved = model ?? config.anthropicModel ?? DEFAULT_DERIVE_ANTHROPIC_MODEL;
		const res = await getAnthropic().messages.create({
			model: resolved,
			max_tokens: MAX_OUTPUT_TOKENS,
			system: request.system,
			messages: [{ role: "user", content: request.prompt }],
		});
		const text = res.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");
		return { text, provider: "anthropic", model: resolved };
	};
}

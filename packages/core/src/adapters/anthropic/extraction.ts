/**
 * @ahkms/core/adapters - Multimodal text extraction adapter (#1616, ADR-101 §3).
 *
 * Encapsulates direct Anthropic (`@anthropic-ai/sdk`) and Gemini (`extractDocumentTextWithGemini`)
 * document/image transcription behind `TextExtractionPort` per `scripts/check-llm-client-location.js`.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SummaryResult } from "../../ports/enrich.js";
import {
	EXTRACTION_PROMPT,
	type ExtractDocumentInput,
	type ExtractDocumentResult,
	type SupportedImageMediaType,
	type TextExtractionPort,
} from "../../ports/extraction.js";
import {
	extractDocumentTextWithGemini,
	generateL2Summary,
} from "../enrich/summary.js";

export const DEFAULT_ANTHROPIC_EXTRACT_MODEL = "claude-opus-4-7";

export interface AnthropicExtractionClient {
	messages: {
		create(args: {
			model: string;
			max_tokens: number;
			messages: Array<{
				role: "user";
				content: Array<
					| {
							type: "document";
							source: {
								type: "base64";
								media_type: "application/pdf";
								data: string;
							};
					  }
					| {
							type: "image";
							source: {
								type: "base64";
								media_type: SupportedImageMediaType;
								data: string;
							};
					  }
					| {
							type: "text";
							text: string;
					  }
				>;
			}>;
		}): Promise<{
			content: Array<{ type: string; text?: string }>;
			stop_reason?: string | null;
		}>;
	};
}

export interface AnthropicTextExtractionAdapterOptions {
	apiKey?: string | (() => string | undefined | Promise<string | undefined>);
	model?: string | (() => string | undefined);
	maxTokens?: number;
	client?:
		| AnthropicExtractionClient
		| (() => AnthropicExtractionClient | Promise<AnthropicExtractionClient>);
	geminiApiKey?: string | (() => string | undefined | Promise<string | undefined>);
	geminiModel?: string | (() => string | undefined);
	provider?: "gemini" | "anthropic" | (() => "gemini" | "anthropic" | undefined);
	extractWithGemini?: typeof extractDocumentTextWithGemini;
	summarize?: (
		text: string | null | undefined,
		title?: string | null,
	) => Promise<SummaryResult>;
}

async function resolveAsyncOption<T>(
	val: T | (() => T | Promise<T>) | undefined,
): Promise<T | undefined> {
	if (val === undefined) return undefined;
	return typeof val === "function" ? await (val as () => T | Promise<T>)() : val;
}

function resolveSyncOption<T>(val: T | (() => T) | undefined): T | undefined {
	if (val === undefined) return undefined;
	return typeof val === "function" ? (val as () => T)() : val;
}

export function createAnthropicTextExtractionAdapter(
	options?: AnthropicTextExtractionAdapterOptions,
): TextExtractionPort {
	const maxTokens = options?.maxTokens ?? 16000;

	return {
		async extract(input: ExtractDocumentInput): Promise<ExtractDocumentResult> {
			const base64 = Buffer.from(input.bytes).toString("base64");
			const prompt = input.prompt ?? EXTRACTION_PROMPT;

			const geminiApiKey =
				options && "geminiApiKey" in options
					? await resolveAsyncOption(options.geminiApiKey)
					: process.env.GEMINI_API_KEY;
			const provider =
				options && "provider" in options
					? resolveSyncOption(options.provider)
					: process.env.KMS_EXTRACT_PROVIDER === "anthropic"
						? "anthropic"
						: undefined;

			if (geminiApiKey && provider !== "anthropic") {
				const geminiModel =
					options && "geminiModel" in options
						? resolveSyncOption(options.geminiModel)
						: process.env.KMS_GEMINI_EXTRACT_MODEL;
				const runGemini = options?.extractWithGemini ?? extractDocumentTextWithGemini;
				return runGemini(base64, input.mediaType, prompt, {
					apiKey: geminiApiKey,
					model: geminiModel,
					maxTokens,
				});
			}

			const model =
				(options && "model" in options
					? resolveSyncOption(options.model)
					: undefined) ??
				process.env.KMS_EXTRACT_MODEL ??
				process.env.EXTRACT_MODEL ??
				DEFAULT_ANTHROPIC_EXTRACT_MODEL;

			let client: AnthropicExtractionClient;
			if (options?.client) {
				client =
					typeof options.client === "function"
						? await options.client()
						: options.client;
			} else {
				const apiKey =
					options && "apiKey" in options
						? await resolveAsyncOption(options.apiKey)
						: process.env.ANTHROPIC_API_KEY;
				if (!apiKey) {
					throw new Error(
						"ANTHROPIC_API_KEY is not set: required for artifact_extract_text. See packages/mcp-server/.env.example",
					);
				}
				client = new Anthropic({ apiKey }) as unknown as AnthropicExtractionClient;
			}

			const source =
				input.mediaType === "application/pdf"
					? {
							type: "document" as const,
							source: {
								type: "base64" as const,
								media_type: "application/pdf" as const,
								data: base64,
							},
						}
					: {
							type: "image" as const,
							source: {
								type: "base64" as const,
								media_type: input.mediaType,
								data: base64,
							},
						};

			const message = await client.messages.create({
				model,
				max_tokens: maxTokens,
				messages: [
					{
						role: "user",
						content: [source, { type: "text", text: prompt }],
					},
				],
			});

			const text = message.content
				.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
				.join("\n")
				.trim();

			return {
				text,
				model,
				truncated: message.stop_reason === "max_tokens",
			};
		},

		async summarize(
			text: string | null | undefined,
			title?: string | null,
		): Promise<SummaryResult> {
			if (options?.summarize) {
				return options.summarize(text, title);
			}
			const apiKey =
				options && "apiKey" in options
					? await resolveAsyncOption(options.apiKey)
					: process.env.ANTHROPIC_API_KEY;
			const geminiApiKey =
				options && "geminiApiKey" in options
					? await resolveAsyncOption(options.geminiApiKey)
					: process.env.GEMINI_API_KEY;
			const model =
				options && "model" in options
					? resolveSyncOption(options.model)
					: undefined;
			const geminiModel =
				options && "geminiModel" in options
					? resolveSyncOption(options.geminiModel)
					: undefined;
			return generateL2Summary(text, title, {
				apiKey,
				geminiApiKey,
				model,
				geminiModel,
			});
		},
	};
}

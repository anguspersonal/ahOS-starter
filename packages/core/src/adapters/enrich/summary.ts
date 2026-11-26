/**
 * @ahkms/core/adapters - L2 summary & multimodal extraction adapter (ADR-101 §3, #1229, #1627).
 *
 * Direct Gemini (`@google/genai`) and Anthropic (`@anthropic-ai/sdk`) usage
 * encapsulated under packages/core/src/adapters/ per scripts/check-llm-client-location.js.
 * Defaults to Google Gemini `gemini-2.5-flash` when `GEMINI_API_KEY` is configured,
 * while keeping Anthropic in place as a fallback or explicit override.
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type {
	GeminiSummaryClient,
	GenerateL2SummaryOptions,
	L2SummaryPort,
	SummaryResult,
} from "../../ports/enrich.js";

export const L2_SUMMARY_SYSTEM_PROMPT =
	"You are a concise, factual summarizer. Produce a neutral 1-2 sentence summary of the document. " +
	"Do not preamble, extrapolate, or use conversational filler. Output only the 1-2 summary sentences.";

export const DEFAULT_L2_SUMMARY_GEMINI_MODEL = "gemini-2.5-flash";
export const FALLBACK_GEMINI_FLASH_MODEL = "gemini-3.8-flash";
export const DEFAULT_L2_SUMMARY_MODEL = "claude-opus-4-7";
export const DEFAULT_EXTRACT_GEMINI_MODEL = "gemini-2.5-flash";

function isNewUserModelUnavailableError(err: unknown, model: string): boolean {
	if (model === FALLBACK_GEMINI_FLASH_MODEL) return false;
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("no longer available to new users") || msg.includes("gemini-3.8-flash");
}

export interface ExtractDocumentWithGeminiOptions {
	apiKey: string;
	model?: string;
	maxTokens?: number;
	client?: GeminiSummaryClient;
}

export interface ExtractDocumentWithGeminiResult {
	text: string;
	model: string;
	truncated: boolean;
}

export function isPdfBuffer(buffer: Buffer): boolean {
	return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function isUndecodedBinary(buffer: Buffer, text?: string | null): boolean {
	if (isPdfBuffer(buffer)) return true;
	if (text && text.trim().startsWith("%PDF-")) return true;
	const headerChunk = buffer.subarray(0, Math.min(buffer.length, 1024));
	return headerChunk.includes(0);
}

/**
 * Generate a neutral 1-2 sentence L2 summary for an enriched document (#1229, #1627).
 *
 * Defaults to Gemini (`gemini-2.5-flash`) when `GEMINI_API_KEY` or `geminiClient` is
 * available, falling back to Anthropic (`claude-opus-4-7`) when `ANTHROPIC_API_KEY` or
 * `client` is provided.
 * Undecoded binary content (%PDF-1.4 header or null bytes) and empty text
 * are strictly skipped with a recorded reason, never sent to the model.
 * A missing API key or model error is handled gracefully without failing the caller.
 */
export async function generateL2Summary(
	text: string | null | undefined,
	title?: string | null,
	options?: GenerateL2SummaryOptions,
): Promise<SummaryResult> {
	const trimmed = (text ?? "").trim();
	if (!trimmed) {
		return { summary: null, skipReason: "empty text content" };
	}

	// Never summarise undecoded binary (the %PDF-1.4 case or raw byte strings)
	if (isUndecodedBinary(Buffer.from(trimmed.slice(0, 1024), "utf-8"), trimmed)) {
		return {
			summary: null,
			skipReason: "undecoded binary content detected (%PDF-1.4 or raw bytes)",
		};
	}

	const geminiApiKey = options?.geminiApiKey ?? process.env.GEMINI_API_KEY;
	const anthropicApiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;
	const hasGemini = Boolean(options?.geminiClient || geminiApiKey);
	const hasAnthropic = Boolean(options?.client || anthropicApiKey);

	// Determine provider: default to Gemini unless an explicit Anthropic client or provider="anthropic" is passed
	let provider: "gemini" | "anthropic" =
		options?.provider ??
		(options?.client && !options?.geminiClient ? "anthropic" : "gemini");
	if (!options?.provider) {
		if (provider === "gemini" && !hasGemini && hasAnthropic) {
			provider = "anthropic";
		} else if (provider === "anthropic" && !hasAnthropic && hasGemini) {
			provider = "gemini";
		}
	}

	if (provider === "gemini" && !hasGemini) {
		return { summary: null, skipReason: "GEMINI_API_KEY or ANTHROPIC_API_KEY not set" };
	}
	if (provider === "anthropic" && !hasAnthropic) {
		return { summary: null, skipReason: "ANTHROPIC_API_KEY not set" };
	}

	const promptText = `${L2_SUMMARY_SYSTEM_PROMPT}\n\nTitle: ${title ?? "Untitled"}\n\nContent:\n${trimmed.slice(0, 10_000)}`;

	try {
		if (provider === "gemini") {
			const gemini =
				options?.geminiClient ??
				(new GoogleGenAI({ apiKey: geminiApiKey }) as unknown as GeminiSummaryClient);
			const nonClaudeModel =
				options?.model && !options.model.startsWith("claude-") ? options.model : undefined;
			const model =
				options?.geminiModel ??
				nonClaudeModel ??
				process.env.KMS_GEMINI_EXTRACT_MODEL ??
				DEFAULT_L2_SUMMARY_GEMINI_MODEL;

			let res: { text?: string };
			try {
				res = await gemini.models.generateContent({
					model,
					contents: promptText,
					config: {
						maxOutputTokens: 150,
					},
				});
			} catch (err) {
				if (!isNewUserModelUnavailableError(err, model)) {
					throw err;
				}
				res = await gemini.models.generateContent({
					model: FALLBACK_GEMINI_FLASH_MODEL,
					contents: promptText,
					config: {
						maxOutputTokens: 300,
						thinkingConfig: { thinkingBudget: 0 },
					},
				});
			}

			const summaryText = (res.text ?? "").trim();
			return { summary: summaryText || null };
		}

		const anthropic = options?.client ?? new Anthropic({ apiKey: anthropicApiKey });
		const model =
			options?.model ??
			process.env.KMS_EXTRACT_MODEL ??
			process.env.EXTRACT_MODEL ??
			DEFAULT_L2_SUMMARY_MODEL;

		const message = await anthropic.messages.create({
			model,
			max_tokens: 150,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: promptText,
						},
					],
				},
			],
		});

		const summaryText = message.content
			.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
			.join("\n")
			.trim();

		return { summary: summaryText || null };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { summary: null, skipReason: `LLM summarization failed: ${msg}` };
	}
}

/**
 * Multimodal PDF/image text extraction via Google Gemini (`gemini-2.5-flash` by default).
 */
export async function extractDocumentTextWithGemini(
	base64Data: string,
	mimeType: string,
	prompt: string,
	options: ExtractDocumentWithGeminiOptions,
): Promise<ExtractDocumentWithGeminiResult> {
	const model =
		options.model ??
		process.env.KMS_GEMINI_EXTRACT_MODEL ??
		DEFAULT_EXTRACT_GEMINI_MODEL;
	const maxOutputTokens = options.maxTokens ?? 16000;
	const gemini =
		options.client ??
		(new GoogleGenAI({ apiKey: options.apiKey }) as unknown as GeminiSummaryClient);

	let activeModel = model;
	const callExtract = (targetModel: string) =>
		gemini.models.generateContent({
			model: targetModel,
			contents: [
				{
					role: "user",
					parts: [
						{
							inlineData: {
								mimeType,
								data: base64Data,
							},
						},
						{
							text: prompt,
						},
					],
				},
			],
			config: {
				maxOutputTokens,
			},
		});
	let response: Awaited<ReturnType<typeof callExtract>>;
	try {
		response = await callExtract(activeModel);
	} catch (err) {
		if (!isNewUserModelUnavailableError(err, activeModel)) {
			throw err;
		}
		activeModel = FALLBACK_GEMINI_FLASH_MODEL;
		response = await callExtract(activeModel);
	}

	const text = (response.text ?? "").trim();
	const finishReason = response.candidates?.[0]?.finishReason;
	return {
		text,
		model: activeModel,
		truncated: finishReason === "MAX_TOKENS",
	};
}

export const l2SummaryPort: L2SummaryPort = {
	generateL2Summary,
};

export function createL2SummaryPort(defaultOptions?: GenerateL2SummaryOptions): L2SummaryPort {
	return {
		generateL2Summary: (text, title, options) =>
			generateL2Summary(text, title, { ...defaultOptions, ...options }),
	};
}

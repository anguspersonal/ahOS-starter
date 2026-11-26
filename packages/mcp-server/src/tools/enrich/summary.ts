import {
	generateL2Summary as coreGenerateL2Summary,
	L2_SUMMARY_SYSTEM_PROMPT,
} from "@ahkms/core/adapters";
import type { SummaryResult } from "@ahkms/core";
import { env } from "../../env.js";

export { L2_SUMMARY_SYSTEM_PROMPT, type SummaryResult };

/**
 * Generate a neutral 1-2 sentence L2 summary for an enriched document (#1229).
 * Delegates to the canonical adapter in @ahkms/core/adapters (#1627), which
 * defaults to Gemini `gemini-2.5-flash` when `GEMINI_API_KEY` is set and
 * falls back to Anthropic when only `ANTHROPIC_API_KEY` is set.
 */
export async function generateL2Summary(
	text: string | null | undefined,
	title?: string | null,
): Promise<SummaryResult> {
	return coreGenerateL2Summary(text, title, {
		geminiApiKey: env.geminiApiKey,
		geminiModel: env.geminiExtractModel,
		apiKey: env.anthropicApiKey,
		model: env.extractModel,
	});
}

/**
 * Port for multimodal document/image text extraction and L2 summary generation (#1616, ADR-101 §1, §3).
 * Pure types and constants only. No external SDKs, database, or environment dependencies.
 */

import type { SummaryResult } from "./enrich.js";

export type SupportedImageMediaType =
	| "image/png"
	| "image/jpeg"
	| "image/webp"
	| "image/gif";

export type ExtractionMediaType = "application/pdf" | SupportedImageMediaType;

export const EXTRACTION_PROMPT =
	"Extract the full text content of this file verbatim as clean Markdown. " +
	"Preserve headings, lists, and tables. Do not summarize, interpret, or add any preamble : output only the extracted text.";

export interface ExtractDocumentInput {
	bytes: Uint8Array;
	mediaType: ExtractionMediaType;
	prompt?: string;
}

export interface ExtractDocumentResult {
	text: string;
	model: string;
	truncated: boolean;
}

export interface TextExtractionPort {
	extract(input: ExtractDocumentInput): Promise<ExtractDocumentResult>;
	summarize?(
		text: string | null | undefined,
		title?: string | null,
	): Promise<SummaryResult>;
}

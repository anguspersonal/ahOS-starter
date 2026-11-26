import { describe, expect, it, vi } from "vitest";
import { EXTRACTION_PROMPT } from "../../ports/extraction.js";
import {
	createAnthropicTextExtractionAdapter,
	DEFAULT_ANTHROPIC_EXTRACT_MODEL,
} from "./extraction.js";

describe("createAnthropicTextExtractionAdapter (#1616)", () => {
	it("extracts PDF text via Anthropic document block when Gemini is not configured", async () => {
		const create = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "  # Heading\n\nBody text  " }],
			stop_reason: "end_turn",
		});

		const adapter = createAnthropicTextExtractionAdapter({
			client: { messages: { create } },
			model: "claude-opus-4-7",
			geminiApiKey: () => undefined,
		});

		const bytes = new TextEncoder().encode("%PDF-1.4 sample");
		const result = await adapter.extract({
			bytes,
			mediaType: "application/pdf",
		});

		expect(result).toEqual({
			text: "# Heading\n\nBody text",
			model: "claude-opus-4-7",
			truncated: false,
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith({
			model: "claude-opus-4-7",
			max_tokens: 16000,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "document",
							source: {
								type: "base64",
								media_type: "application/pdf",
								data: Buffer.from(bytes).toString("base64"),
							},
						},
						{
							type: "text",
							text: EXTRACTION_PROMPT,
						},
					],
				},
			],
		});
	});

	it("extracts image text via Anthropic image block and sets truncated=true on max_tokens", async () => {
		const create = vi.fn().mockResolvedValue({
			content: [
				{ type: "text", text: "Part 1" },
				{ type: "text", text: "Part 2" },
			],
			stop_reason: "max_tokens",
		});

		const adapter = createAnthropicTextExtractionAdapter({
			client: () => ({ messages: { create } }),
			geminiApiKey: () => undefined,
		});

		const bytes = new Uint8Array([137, 80, 78, 71]);
		const result = await adapter.extract({
			bytes,
			mediaType: "image/png",
			prompt: "Custom prompt",
		});

		expect(result).toEqual({
			text: "Part 1\nPart 2",
			model: DEFAULT_ANTHROPIC_EXTRACT_MODEL,
			truncated: true,
		});
		expect(create).toHaveBeenCalledWith({
			model: DEFAULT_ANTHROPIC_EXTRACT_MODEL,
			max_tokens: 16000,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: "image/png",
								data: Buffer.from(bytes).toString("base64"),
							},
						},
						{
							type: "text",
							text: "Custom prompt",
						},
					],
				},
			],
		});
	});

	it("prefers Gemini multimodal extraction when geminiApiKey is configured and provider is not anthropic", async () => {
		const create = vi.fn();
		const extractWithGemini = vi.fn().mockResolvedValue({
			text: "Gemini extracted text",
			model: "gemini-2.5-flash",
			truncated: false,
		});

		const adapter = createAnthropicTextExtractionAdapter({
			client: { messages: { create } },
			geminiApiKey: () => "gem-key-123",
			geminiModel: () => "gemini-2.5-flash",
			extractWithGemini,
		});

		const bytes = new TextEncoder().encode("%PDF-1.4");
		const result = await adapter.extract({
			bytes,
			mediaType: "application/pdf",
		});

		expect(result).toEqual({
			text: "Gemini extracted text",
			model: "gemini-2.5-flash",
			truncated: false,
		});
		expect(extractWithGemini).toHaveBeenCalledWith(
			Buffer.from(bytes).toString("base64"),
			"application/pdf",
			EXTRACTION_PROMPT,
			{
				apiKey: "gem-key-123",
				model: "gemini-2.5-flash",
				maxTokens: 16000,
			},
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("delegates summarize to custom summarize or generateL2Summary", async () => {
		const summarize = vi.fn().mockResolvedValue({ summary: "Short L2 summary" });
		const adapter = createAnthropicTextExtractionAdapter({
			client: { messages: { create: vi.fn() } },
			summarize,
		});

		const res = await adapter.summarize!("Document body", "Doc Title");
		expect(res).toEqual({ summary: "Short L2 summary" });
		expect(summarize).toHaveBeenCalledWith("Document body", "Doc Title");
	});
});

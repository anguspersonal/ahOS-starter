import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	generateL2Summary,
	extractDocumentTextWithGemini,
	L2_SUMMARY_SYSTEM_PROMPT,
	DEFAULT_L2_SUMMARY_GEMINI_MODEL,
	createL2SummaryPort,
	l2SummaryPort,
	isPdfBuffer,
	isUndecodedBinary,
} from "./summary.js";
import type { AnthropicSummaryClient, GeminiSummaryClient } from "../../ports/enrich.js";

describe("generateL2Summary adapter (#1627)", () => {
	const origApiKey = process.env.ANTHROPIC_API_KEY;
	const origGeminiKey = process.env.GEMINI_API_KEY;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (origApiKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = origApiKey;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
		if (origGeminiKey !== undefined) {
			process.env.GEMINI_API_KEY = origGeminiKey;
		} else {
			delete process.env.GEMINI_API_KEY;
		}
	});

	describe("Case 1: Exact prompt sending and summary extraction (Gemini default + Anthropic fallback)", () => {
		it("defaults to Gemini (gemini-2.5-flash) when geminiClient is provided", async () => {
			const mockGenerateContent = vi.fn().mockResolvedValue({
				text: "  Concise Gemini 2.5 Flash summary. \n",
			});
			const mockGeminiClient: GeminiSummaryClient = {
				models: {
					generateContent: mockGenerateContent,
				},
			};

			const res = await generateL2Summary("Document text here", "My Gemini Doc", {
				geminiClient: mockGeminiClient,
			});

			expect(mockGenerateContent).toHaveBeenCalledTimes(1);
			expect(mockGenerateContent).toHaveBeenCalledWith({
				model: DEFAULT_L2_SUMMARY_GEMINI_MODEL,
				contents: `${L2_SUMMARY_SYSTEM_PROMPT}\n\nTitle: My Gemini Doc\n\nContent:\nDocument text here`,
				config: {
					maxOutputTokens: 150,
				},
			});
			expect(res).toEqual({
				summary: "Concise Gemini 2.5 Flash summary.",
			});
		});

		it("transparently retries with gemini-3.8-flash when gemini-2.5-flash is unavailable to new Google API keys", async () => {
			const mockGenerateContent = vi
				.fn()
				.mockRejectedValueOnce(
					new Error(
						"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.",
					),
				)
				.mockResolvedValueOnce({
					text: "  Fallback Gemini 3.8 Flash summary. \n",
				});
			const mockGeminiClient: GeminiSummaryClient = {
				models: {
					generateContent: mockGenerateContent,
				},
			};

			const res = await generateL2Summary("Document text here", "My Gemini Doc", {
				geminiClient: mockGeminiClient,
			});

			expect(mockGenerateContent).toHaveBeenCalledTimes(2);
			expect((mockGenerateContent.mock.calls[0] as any[])[0].model).toBe("gemini-2.5-flash");
			expect((mockGenerateContent.mock.calls[1] as any[])[0].model).toBe("gemini-3.8-flash");
			expect(res).toEqual({
				summary: "Fallback Gemini 3.8 Flash summary.",
			});
		});

		it("sends exact system prompt, title, and sliced content to Anthropic and returns trimmed summary", async () => {
			const mockCreate = vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "  This is a concise 1-2 sentence summary.  \n" }],
			});
			const mockClient: AnthropicSummaryClient = {
				messages: {
					create: mockCreate,
				},
			};

			const longText = "First part of the text. ".repeat(600); // > 10,000 chars
			const trimmedText = longText.trim();
			const expectedSlice = trimmedText.slice(0, 10_000);
			const title = "Quarterly Research Update";

			const res = await generateL2Summary(longText, title, {
				client: mockClient,
				model: "claude-test-model",
			});

			expect(mockCreate).toHaveBeenCalledTimes(1);
			expect(mockCreate).toHaveBeenCalledWith({
				model: "claude-test-model",
				max_tokens: 150,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `${L2_SUMMARY_SYSTEM_PROMPT}\n\nTitle: ${title}\n\nContent:\n${expectedSlice}`,
							},
						],
					},
				],
			});
			expect(res).toEqual({
				summary: "This is a concise 1-2 sentence summary.",
			});
		});

		it("falls back to Untitled when title is null or omitted", async () => {
			const mockCreate = vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "Summary text." }],
			});
			const mockClient: AnthropicSummaryClient = {
				messages: { create: mockCreate },
			};

			await generateL2Summary("Some valid document text", null, { client: mockClient });

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `${L2_SUMMARY_SYSTEM_PROMPT}\n\nTitle: Untitled\n\nContent:\nSome valid document text`,
								},
							],
						},
					],
				}),
			);
		});
	});

	describe("Case 2: Empty text and undecoded binary skipping without LLM call", () => {
		it("skips empty or whitespace-only text without calling Anthropic", async () => {
			const mockCreate = vi.fn();
			const mockClient: AnthropicSummaryClient = {
				messages: { create: mockCreate },
			};

			const resNull = await generateL2Summary(null, "Title", { client: mockClient });
			expect(resNull).toEqual({ summary: null, skipReason: "empty text content" });

			const resUndefined = await generateL2Summary(undefined, "Title", { client: mockClient });
			expect(resUndefined).toEqual({ summary: null, skipReason: "empty text content" });

			const resWhitespace = await generateL2Summary("   \n\t  ", "Title", { client: mockClient });
			expect(resWhitespace).toEqual({ summary: null, skipReason: "empty text content" });

			expect(mockCreate).not.toHaveBeenCalled();
		});

		it("skips undecoded binary (%PDF-1.4 header) without calling Anthropic", async () => {
			const mockCreate = vi.fn();
			const mockClient: AnthropicSummaryClient = {
				messages: { create: mockCreate },
			};

			const rawPdfText = "%PDF-1.4\n%xxxx\n1 0 obj<</Type/Catalog>>";
			const res = await generateL2Summary(rawPdfText, "Test Document", { client: mockClient });

			expect(res.summary).toBeNull();
			expect(res.skipReason).toBe(
				"undecoded binary content detected (%PDF-1.4 or raw bytes)",
			);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it("skips undecoded binary with null bytes without calling Anthropic", async () => {
			const mockCreate = vi.fn();
			const mockClient: AnthropicSummaryClient = {
				messages: { create: mockCreate },
			};

			const rawBytesText = "hello\0world raw binary string";
			const res = await generateL2Summary(rawBytesText, "Binary Document", { client: mockClient });

			expect(res.summary).toBeNull();
			expect(res.skipReason).toBe(
				"undecoded binary content detected (%PDF-1.4 or raw bytes)",
			);
			expect(mockCreate).not.toHaveBeenCalled();
		});
	});

	describe("Case 3: Missing API key or thrown client error handling", () => {
		it("returns skipReason when neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set and no client is provided", async () => {
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.GEMINI_API_KEY;

			const res = await generateL2Summary("Valid document text", "Test Doc");

			expect(res).toEqual({
				summary: null,
				skipReason: "GEMINI_API_KEY or ANTHROPIC_API_KEY not set",
			});
		});

		it("extractDocumentTextWithGemini extracts text and reports truncation on MAX_TOKENS", async () => {
			const mockGenerateContent = vi.fn().mockResolvedValue({
				text: "  # Extracted PDF Heading\nBody text  ",
				candidates: [{ finishReason: "MAX_TOKENS" }],
			});
			const mockGeminiClient: GeminiSummaryClient = {
				models: { generateContent: mockGenerateContent },
			};

			const out = await extractDocumentTextWithGemini(
				"dGVzdA==",
				"application/pdf",
				"Extract verbatim",
				{ apiKey: "fake-key", client: mockGeminiClient },
			);

			expect(out).toEqual({
				text: "# Extracted PDF Heading\nBody text",
				model: "gemini-2.5-flash",
				truncated: true,
			});
			expect(mockGenerateContent).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "gemini-2.5-flash",
					config: { maxOutputTokens: 16000 },
				}),
			);
		});

		it("catches thrown client errors gracefully without throwing", async () => {
			const mockCreate = vi.fn().mockRejectedValue(new Error("Rate limit exceeded"));
			const mockClient: AnthropicSummaryClient = {
				messages: { create: mockCreate },
			};

			const res = await generateL2Summary("Valid document text", "Test Doc", {
				client: mockClient,
			});

			expect(res).toEqual({
				summary: null,
				skipReason: "LLM summarization failed: Rate limit exceeded",
			});
		});

		it("handles non-Error thrown objects gracefully", async () => {
			const mockCreate = vi.fn().mockRejectedValue("string failure");
			const mockClient: AnthropicSummaryClient = {
				messages: { create: mockCreate },
			};

			const res = await generateL2Summary("Valid document text", "Test Doc", {
				client: mockClient,
			});

			expect(res).toEqual({
				summary: null,
				skipReason: "LLM summarization failed: string failure",
			});
		});
	});

	describe("Port and binary helper verifications", () => {
		it("l2SummaryPort exposes generateL2Summary", async () => {
			expect(typeof l2SummaryPort.generateL2Summary).toBe("function");
		});

		it("createL2SummaryPort binds default options", async () => {
			const mockCreate = vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "Port summary." }],
			});
			const mockClient: AnthropicSummaryClient = {
				messages: { create: mockCreate },
			};

			const port = createL2SummaryPort({ client: mockClient });
			const res = await port.generateL2Summary("Some text", "My Doc");

			expect(res).toEqual({ summary: "Port summary." });
			expect(mockCreate).toHaveBeenCalledTimes(1);
		});

		it("isPdfBuffer and isUndecodedBinary behave consistently with selection helpers", () => {
			const pdfBuf = Buffer.from("%PDF-1.4\nheader");
			expect(isPdfBuffer(pdfBuf)).toBe(true);
			expect(isUndecodedBinary(pdfBuf)).toBe(true);

			const nullBuf = Buffer.from([0x61, 0x00, 0x62]);
			expect(isPdfBuffer(nullBuf)).toBe(false);
			expect(isUndecodedBinary(nullBuf)).toBe(true);

			const cleanBuf = Buffer.from("clean ascii text");
			expect(isPdfBuffer(cleanBuf)).toBe(false);
			expect(isUndecodedBinary(cleanBuf)).toBe(false);
		});
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUrlSafely } from "@ahkms/shared";

vi.mock("@ahkms/shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ahkms/shared")>();
	return {
		...actual,
		fetchUrlSafely: vi.fn(),
	};
});

import { isUrlOnlyArtifact, enrichNextCore } from "../tools/enrichNext.js";
import { extractHtmlText, fetchUrl, isDisallowedIp } from "../tools/enrich/urlAdapter.js";
import { isUrlConnector } from "@ahkms/core";
import { supabase } from "../supabase.js";
import * as urlAdapterModule from "../tools/enrich/urlAdapter.js";
import * as embeddingsModule from "../embeddings.js";

const TEST_USER = "00000000-0000-0000-0000-000000000000";

describe("URL enrichment (#638 §2)", () => {
	describe("isUrlConnector", () => {
		it("recognizes url connectors", () => {
			expect(isUrlConnector("url")).toBe(true);
			expect(isUrlConnector("web")).toBe(true);
			expect(isUrlConnector("discovered_url")).toBe(true);
			expect(isUrlConnector("gdrive")).toBe(false);
			expect(isUrlConnector("notion")).toBe(false);
		});
	});

	describe("extractHtmlText", () => {
		it("extracts page title and readable content, stripping noise elements", () => {
			const html = `
				<!DOCTYPE html>
				<html>
					<head>
						<title>Article Title &amp; More</title>
						<script>console.log("ignore me");</script>
						<style>body { font-size: 14px; }</style>
					</head>
					<body>
						<nav><a href="/">Home</a></nav>
						<header>Site Header</header>
						<article>
							<h1>Headline</h1>
							<p>Paragraph 1 with &quot;quotes&quot;.</p>
							<p>Paragraph 2 &lt;content&gt;.</p>
						</article>
						<footer>Site Footer</footer>
					</body>
				</html>
			`;

			const res = extractHtmlText(html);
			expect(res.title).toBe("Article Title & More");
			expect(res.text).toContain("Headline");
			expect(res.text).toContain('Paragraph 1 with "quotes".');
			expect(res.text).toContain("Paragraph 2 <content>.");
			expect(res.text).not.toContain("Site Header");
			expect(res.text).not.toContain("Site Footer");
			expect(res.text).not.toContain("console.log");
		});

		it("handles empty or non-string input safely", () => {
			expect(extractHtmlText("")).toEqual({ title: null, text: "" });
			expect(extractHtmlText(null as any)).toEqual({ title: null, text: "" });
		});
	});

	describe("isUrlOnlyArtifact", () => {
		it("identifies artifacts where source_url is present and plain_text is empty or equal to url", () => {
			expect(
				isUrlOnlyArtifact({
					source_url: "https://example.com/doc",
					plain_text: "",
				}),
			).toBe(true);

			expect(
				isUrlOnlyArtifact({
					source_url: "https://example.com/doc",
					plain_text: "https://example.com/doc",
				}),
			).toBe(true);

			expect(
				isUrlOnlyArtifact({
					source: "https://example.com/page",
					plain_text: null,
				}),
			).toBe(true);
		});

		it("returns false when plain_text has substantial extracted content", () => {
			expect(
				isUrlOnlyArtifact({
					source_url: "https://example.com/doc",
					plain_text: "This is real extracted text with notes and thoughts.",
				}),
			).toBe(false);
		});

		it("returns false when bytes are already stored in an app storage bucket", () => {
			expect(
				isUrlOnlyArtifact({
					source_url: "https://example.com/doc",
					plain_text: "",
					storage_bucket: "user-uploads",
					storage_path: "enriched/url/u1/a1.html",
				}),
			).toBe(false);
		});

		it("returns false when neither source_url nor source is a URL", () => {
			expect(
				isUrlOnlyArtifact({
					source: "gdrive-file-12345",
					plain_text: "",
				}),
			).toBe(false);
		});
	});

	describe("enrichNextCore on-demand URL enrichment", () => {
		const origFrom = supabase.from;
		const origStorage = supabase.storage;

		beforeEach(() => {
			vi.restoreAllMocks();
		});

		afterEach(() => {
			(supabase as any).from = origFrom;
			(supabase as any).storage = origStorage;
		});

		it("enriches a URL-only artifact on-demand when artifact_id is passed", async () => {
			const artifactId = "11111111-1111-4111-8111-111111111111";
			const sampleHtml = "<html><head><title>Test Article</title></head><body><p>Hello world</p></body></html>";

			vi.spyOn(urlAdapterModule.urlAdapter, "fetch").mockResolvedValue({
				buffer: Buffer.from(sampleHtml),
				mimeType: "text/html",
				extension: "html",
				contentHash: "hash123",
				sourceName: "Test Article",
				text: "Hello world",
			});

			const embedSpy = vi.spyOn(embeddingsModule, "embedAndStore").mockResolvedValue({} as any);

			let uploadedPath = "";
			let uploadedContentType = "";
			(supabase as any).storage = {
				from: () => ({
					upload: async (path: string, _buf: any, opts: any) => {
						uploadedPath = path;
						uploadedContentType = opts?.contentType;
						return { error: null };
					},
				}),
			};

			let updatedRowData: any = null;
			(supabase as any).from = vi.fn((table: string) => {
				const b: any = {
					select: () => b,
					eq: () => b,
					maybeSingle: async () => ({
						data: {
							id: artifactId,
							title: "https://example.com/article",
							source: null,
							source_channel: "web",
							source_url: "https://example.com/article",
							plain_text: "",
							storage_bucket: null,
							storage_path: null,
							storage_url: null,
							lifecycle_stage: "discovered",
							processing_status: "pending",
							processing_metadata: {},
						},
						error: null,
					}),
					update: (data: any) => {
						updatedRowData = data;
						return b;
					},
				};
				return b;
			});

			const result = await enrichNextCore({ artifact_id: artifactId });

			expect(result.enriched).toBe(1);
			expect(result.failed).toBe(0);
			expect(uploadedPath).toBe(`enriched/url/${TEST_USER}/${artifactId}.html`);
			expect(uploadedContentType).toBe("text/html");
			expect(updatedRowData).not.toBeNull();
			expect(updatedRowData.title).toBe("Test Article");
			// Must store the adapter's extracted text, not the raw HTML buffer
			// (#638 round-1 QA finding: plain_text was silently the raw markup).
			expect(updatedRowData.plain_text).toBe("Hello world");
			expect(updatedRowData.plain_text).not.toContain("<html>");
			expect(updatedRowData.plain_text).not.toContain("<p>");
			expect(updatedRowData.lifecycle_stage).toBe("extracted");
			expect(updatedRowData.processing_status).toBe("completed");
			expect(embedSpy).toHaveBeenCalledWith(
				"artifacts",
				artifactId,
				expect.objectContaining({
					plain_text: expect.stringContaining("Hello world"),
				}),
			);
		});

		it("records failures on row without retrying forever when URL fetch fails", async () => {
			const artifactId = "22222222-2222-4222-8222-222222222222";

			vi.spyOn(urlAdapterModule.urlAdapter, "fetch").mockRejectedValue(new Error("HTTP 404 Not Found"));

			let markedFailedData: any = null;
			(supabase as any).from = vi.fn((table: string) => {
				const b: any = {
					select: () => b,
					eq: () => b,
					maybeSingle: async () => ({
						data: {
							id: artifactId,
							title: "Untitled",
							source: "https://example.com/missing",
							source_channel: "web",
							source_url: "https://example.com/missing",
							plain_text: null,
							lifecycle_stage: "discovered",
							processing_metadata: {},
						},
						error: null,
					}),
					update: (data: any) => {
						markedFailedData = data;
						return b;
					},
				};
				return b;
			});

			const result = await enrichNextCore({ artifact_id: artifactId });

			expect(result.enriched).toBe(0);
			expect(result.failed).toBe(1);
			expect(result.notes[0]).toContain("HTTP 404 Not Found");
			expect(markedFailedData).not.toBeNull();
			expect(markedFailedData.lifecycle_stage).toBe("failed");
			expect(markedFailedData.processing_status).toBe("failed");
			expect(markedFailedData.processing_metadata.enrichment_error).toBe("HTTP 404 Not Found");
		});

		it("returns already enriched note without re-fetching if artifact already has stored bytes", async () => {
			const artifactId = "33333333-3333-4333-8333-333333333333";
			const fetchSpy = vi.spyOn(urlAdapterModule.urlAdapter, "fetch");

			(supabase as any).from = vi.fn((table: string) => {
				const b: any = {
					select: () => b,
					eq: () => b,
					maybeSingle: async () => ({
						data: {
							id: artifactId,
							title: "Already Extracted",
							source_url: "https://example.com/done",
							plain_text: "Substantial extracted text from prior enrichment.",
							storage_bucket: "user-uploads",
							storage_path: "enriched/url/u1/done.html",
							lifecycle_stage: "extracted",
						},
						error: null,
					}),
				};
				return b;
			});

			const result = await enrichNextCore({ artifact_id: artifactId });

			expect(result.enriched).toBe(0);
			expect(result.failed).toBe(0);
			expect(result.notes[0]).toContain("already enriched");
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("drains URL-only artifacts during scheduled cadence when connector: 'url' is provided", async () => {
			const artifactId = "44444444-4444-4444-8444-444444444444";
			vi.spyOn(urlAdapterModule.urlAdapter, "fetch").mockResolvedValue({
				buffer: Buffer.from("<html><head><title>Batch URL</title></head><body><p>Content</p></body></html>"),
				mimeType: "text/html",
				extension: "html",
				contentHash: "hash444",
				sourceName: "Batch URL",
				text: "Content",
			});

			vi.spyOn(embeddingsModule, "embedAndStore").mockResolvedValue({} as any);

			(supabase as any).storage = {
				from: () => ({
					upload: async () => ({ error: null }),
				}),
			};

			const queries: string[] = [];
			(supabase as any).from = vi.fn((table: string) => {
				queries.push(table);
				const b: any = {
					select: () => b,
					eq: () => b,
					in: () => b,
					or: () => b,
					neq: () => b,
					not: () => b,
					is: () => b,
					order: () => b,
					limit: async () => ({
						data: [
							{
								id: artifactId,
								title: "https://example.com/batch",
								source: null,
								source_channel: "web",
								source_url: "https://example.com/batch",
								plain_text: "",
								storage_bucket: null,
								storage_path: null,
								storage_url: null,
								lifecycle_stage: "discovered",
								processing_status: "pending",
								processing_metadata: {},
							},
						],
						error: null,
					}),
					update: () => b,
					then: (resolve: (v: { count: number | null }) => void) => resolve({ count: 0 }),
				};
				return b;
			});

			const result = await enrichNextCore({ connector: "url", limit: 5 });

			expect(result.enriched).toBe(1);
			expect(result.failed).toBe(0);
			expect(result.remaining_discovered).toBe(0);
		});
	});

	// Thin integration coverage for fetchUrl:
	// - input validation
	// - direct fetch via fetchUrlSafely
	describe("fetchUrl integration", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("rejects a non-string/empty URL", async () => {
			await expect(fetchUrl("")).rejects.toThrow(/non-empty string/);
		});

		it("rejects an invalid URL", async () => {
			await expect(fetchUrl("not a url")).rejects.toThrow(/Invalid URL/);
		});

		it("rejects an unsupported protocol", async () => {
			await expect(fetchUrl("ftp://example.com/file")).rejects.toThrow(/Unsupported protocol/);
		});

		it("delegates to fetchUrlSafely on direct fetch and maps to FetchedContent", async () => {
			const mockFetchResult = {
				url: "http://public.example/page",
				title: "Direct Page",
				text: "Clean extracted body",
				mimeType: "text/html",
				extension: "html",
				buffer: Buffer.from("Clean extracted body"),
				contentHash: "hash-123",
			};
			vi.mocked(fetchUrlSafely).mockResolvedValue(mockFetchResult);

			const result = await fetchUrl("http://public.example/page");

			expect(fetchUrlSafely).toHaveBeenCalledWith(
				"http://public.example/page",
				expect.objectContaining({
					userAgent: "Mozilla/5.0 (compatible; ahOS-Enrich/1.0; +https://github.com/anguspersonal/ahOS)",
				}),
			);
			expect(result.sourceName).toBe("Direct Page");
			expect(result.text).toBe("Clean extracted body");
			expect(result.mimeType).toBe("text/html");
			expect(result.extension).toBe("html");
			expect(result.contentHash).toBe("hash-123");
			expect(result.buffer).toEqual(mockFetchResult.buffer);
		});

		it("propagates errors from fetchUrlSafely on direct fetch", async () => {
			vi.mocked(fetchUrlSafely).mockRejectedValue(new Error("Refusing to fetch private/loopback address: 127.0.0.1"));

			await expect(fetchUrl("http://127.0.0.1/admin")).rejects.toThrow(/private\/loopback/);
		});
	});

	describe("isDisallowedIp", () => {
		it("flags private, loopback, and link-local ranges", () => {
			expect(isDisallowedIp("127.0.0.1")).toBe(true);
			expect(isDisallowedIp("10.1.2.3")).toBe(true);
			expect(isDisallowedIp("172.16.0.1")).toBe(true);
			expect(isDisallowedIp("192.168.1.1")).toBe(true);
			expect(isDisallowedIp("169.254.1.1")).toBe(true);
			expect(isDisallowedIp("::1")).toBe(true);
			expect(isDisallowedIp("fe80::1")).toBe(true);
			expect(isDisallowedIp("fc00::1")).toBe(true);
			expect(isDisallowedIp("::ffff:127.0.0.1")).toBe(true);
		});

		it("allows ordinary public addresses", () => {
			expect(isDisallowedIp("93.184.216.34")).toBe(false);
			expect(isDisallowedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
		});
	});
});


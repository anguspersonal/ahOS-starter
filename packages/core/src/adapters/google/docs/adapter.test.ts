import { afterEach, describe, expect, it, vi } from "vitest";
import type { Domain } from "../../../domain/domains.js";
import type { DocsDocument } from "../../../ports/docs.js";
import { createGoogleDocsAdapter, DocsApiError } from "./adapter.js";

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createGoogleDocsAdapter (issue #1514)", () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	it("1. POSTs token exchange once and GETs documents/<id> with includeTabsContent, suggestionsViewMode and fields", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const sampleDoc: DocsDocument = {
			documentId: "doc-123", title: "Q4 Strategy", revisionId: "rev-99",
			tabs: [{
				tabProperties: { tabId: "t.0", title: "Overview", index: 0 },
				documentTab: { body: { content: [{ startIndex: 1, endIndex: 15, paragraph: { elements: [{ startIndex: 1, endIndex: 15, textRun: { content: "Heading text\n" } }], paragraphStyle: { namedStyleType: "HEADING_1" } } }] } },
				childTabs: [],
			}],
		};
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "at-angus-1" });
			return jsonResponse(sampleDoc);
		}) as unknown as typeof fetch;

		const adapter = createGoogleDocsAdapter({
			clientId: "cid", clientSecret: "csecret",
			refreshToken: async (d) => (d === "angus" ? "rt-angus" : "rt-work"),
			fetchFn,
		});
		const result = await adapter.getDocument({
			domain: "angus", documentId: "doc-123", includeTabsContent: true,
			suggestionsViewMode: "SUGGESTIONS_INLINE", fields: "documentId,title,revisionId,tabs",
		});

		expect(result).toEqual(sampleDoc);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(String(calls[0]?.init?.body)).toContain("refresh_token=rt-angus");
		const docUrl = new URL(calls[1]!.url);
		expect(`${docUrl.origin}${docUrl.pathname}`).toBe("https://docs.googleapis.com/v1/documents/doc-123");
		expect(docUrl.searchParams.get("includeTabsContent")).toBe("true");
		expect(docUrl.searchParams.get("suggestionsViewMode")).toBe("SUGGESTIONS_INLINE");
		expect(docUrl.searchParams.get("fields")).toBe("documentId,title,revisionId,tabs");
		expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer at-angus-1");
	});

	it("2. refuses an unknown domain or missing credentials before any request, naming the domain", async () => {
		const fetchFn = vi.fn() as unknown as typeof fetch;
		const refreshToken = vi.fn(async () => "  ");
		const adapter = createGoogleDocsAdapter({ clientId: "cid", clientSecret: "csecret", refreshToken, fetchFn });

		await expect(adapter.getDocument({ domain: "bogus" as Domain, documentId: "doc-1" })).rejects.toThrow(/bogus/);
		expect(refreshToken).not.toHaveBeenCalled();
		expect(fetchFn).not.toHaveBeenCalled();
		await expect(adapter.getDocument({ domain: "work", documentId: "doc-1" })).rejects.toThrow(/work/);
		expect(fetchFn).not.toHaveBeenCalled();

		const missingClient = createGoogleDocsAdapter({ clientId: "", clientSecret: "csecret", refreshToken: async () => "rt-angus", fetchFn });
		await expect(missingClient.getDocument({ domain: "angus", documentId: "doc-1" })).rejects.toThrow(/angus/);
		const missingSecret = createGoogleDocsAdapter({ clientId: "cid", clientSecret: " ", refreshToken: async () => "rt-work", fetchFn });
		await expect(missingSecret.getDocument({ domain: "work", documentId: "doc-1" })).rejects.toThrow(/work/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("3. non-2xx Google response throws error with numeric status, Google status string, and never the token", async () => {
		const secretAccess = "ya29.SECRET-DOCS-ACCESS-TOKEN";
		const secretRefresh = "1//03-SECRET-DOCS-REFRESH-TOKEN";
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: secretAccess });
			return jsonResponse({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND", details: [{ reason: "notFound" }] } }, 404);
		}) as unknown as typeof fetch;

		const adapter = createGoogleDocsAdapter({ clientId: "cid", clientSecret: "csecret", refreshToken: async () => secretRefresh, fetchFn });
		const err = await adapter.getDocument({ domain: "work", documentId: "missing-doc" }).catch((e) => e);
		expect(err).toBeInstanceOf(DocsApiError);
		expect([err.status, err.googleStatus, err.reason]).toEqual([404, "NOT_FOUND", "notFound"]);
		expect(err.message).toContain("NOT_FOUND");
		expect(err.message).not.toContain(secretAccess);
		expect(err.message).not.toContain(secretRefresh);
	});

	it("4. failed token exchange throws a plain Error naming the domain, HTTP status and error code, never the body", async () => {
		const rawBodySecret = "SENSITIVE_TOKEN_EXCHANGE_RESPONSE_BODY";
		const secretRefresh = "1//03-SECRET-REFRESH";
		const fetchFn = vi.fn(async () =>
			jsonResponse({ error: "invalid_grant", error_description: `${rawBodySecret} ${secretRefresh}` }, 400),
		) as unknown as typeof fetch;

		const adapter = createGoogleDocsAdapter({ clientId: "cid", clientSecret: "csecret", refreshToken: async () => secretRefresh, fetchFn });
		const err = await adapter.getDocument({ domain: "angus", documentId: "doc-1" }).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("Error");
		expect(err.message).toMatch(/angus.*400.*invalid_grant/);
		expect(err.message).not.toContain(rawBodySecret);
		expect(err.message).not.toContain(secretRefresh);
	});

	it("5. resolves fetch per call (config.fetchFn ?? globalThis.fetch) so vi.stubGlobal('fetch') after construction is used", async () => {
		const adapter = createGoogleDocsAdapter({ clientId: "cid", clientSecret: "csecret", refreshToken: async () => "rt-angus" });
		const lateFetch = vi.fn(async (input: RequestInfo | URL) =>
			String(input) === "https://oauth2.googleapis.com/token"
				? jsonResponse({ access_token: "at-late" })
				: jsonResponse({ documentId: "doc-late", title: "Late Stubbed Doc", revisionId: "rev-1", body: { content: [] } }),
		);
		vi.stubGlobal("fetch", lateFetch);
		const doc = await adapter.getDocument({ domain: "angus", documentId: "doc-late" });
		expect([doc.documentId, doc.title, lateFetch.mock.calls.length]).toEqual(["doc-late", "Late Stubbed Doc", 2]);
	});

	it("6. batchUpdate POSTs documents/<id>:batchUpdate with requests and writeControl (#1521)", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "at-angus-2" });
			return jsonResponse({
				documentId: "doc-123",
				writeControl: { requiredRevisionId: "rev-new" },
				replies: [{ insertText: {} }],
			});
		}) as unknown as typeof fetch;

		const adapter = createGoogleDocsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-angus",
			fetchFn,
		});
		const res = await adapter.batchUpdate!({
			domain: "angus",
			documentId: "doc-123",
			requests: [{ insertText: { text: "hello", location: { index: 1 } } }],
			writeControl: { requiredRevisionId: "rev-old", writeMode: "SUGGEST" },
		});

		expect(res.writeControl?.requiredRevisionId).toBe("rev-new");
		expect(calls[1]?.url).toBe("https://docs.googleapis.com/v1/documents/doc-123:batchUpdate");
		expect(calls[1]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			requests: [{ insertText: { text: "hello", location: { index: 1 } } }],
			writeControl: { requiredRevisionId: "rev-old", writeMode: "SUGGEST" },
		});
	});
});

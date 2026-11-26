import { describe, expect, it, vi } from "vitest";
import { createGoogleDocsAdapter, DocsApiError } from "../../adapters/google/docs/adapter.js";
import { createGoogleDriveAdapter } from "../../adapters/google/drive/index.js";
import type { DocsPort } from "../../ports/docs.js";
import { executeAction } from "../adapters/direct.js";
import { createDocsBatchUpdateAction } from "./batchUpdate.js";
import { createDocsCommentsAction } from "./comments.js";
import { createDocsGetAction } from "./get.js";

type Handler = (url: URL, init?: RequestInit) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const STALE = "The required revision ID 'AHj4eMT-iY_uIZEkTXEh3liXTV0_5DwQyF4UZINPQHPsvJ5EZ-r1pjTTvqFM3wr_7ZqOF45WXXRSnUbU5ABe5VpfGyld8F1ygKponeoVDIw' does not match the latest revision.";

function makeConfig(handler: Handler) {
	const sleeps: number[] = [];
	const config = {
		clientId: "cid", clientSecret: "csec", refreshToken: async () => "rt",
		sleepFn: async (ms: number) => { sleeps.push(ms); },
		fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			return url.href === "https://oauth2.googleapis.com/token" ? json({ access_token: "tok-1" }) : handler(url, init);
		}) as typeof fetch,
	};
	return { config, sleeps };
}

const batchArgs = { document_id: "doc-1", domain: "angus" as const, required_revision_id: "rev-stale", requests: [{ insertText: { location: { index: 1 }, text: "x" } }] };
const runBatch = (docs: DocsPort) => executeAction(createDocsBatchUpdateAction(docs), batchArgs, { context: { caller: "mcp" } });
const rejecting = (err: Error) => ({ getDocument: vi.fn(), batchUpdate: vi.fn().mockRejectedValue(err) }) as unknown as DocsPort;

describe("Docs ops alignment (#1655)", () => {
	it("1. docs_comments list returns drive_comment_list's contract and finds an open comment behind a page of resolved ones", async () => {
		const pageSizes: Array<string | null> = [];
		const { config } = makeConfig((url) => {
			pageSizes.push(url.searchParams.get("pageSize"));
			return url.searchParams.get("pageToken") === "page-2"
				? json({ comments: [{ id: "open-1", content: "Still open", resolved: false }] })
				: json({ comments: Array.from({ length: 20 }, (_, i) => ({ id: `r-${i}`, content: "done", resolved: true })), nextPageToken: "page-2" });
		});
		const action = createDocsCommentsAction(createGoogleDriveAdapter(config));
		const out = await executeAction(action, { document_id: "doc-1", domain: "angus", action: "list" }, { context: { caller: "mcp" } });
		expect(out).toMatchObject({ domain: "angus", file_id: "doc-1", include_resolved: false, scanned: 21, next_cursor: null });
		expect("comments" in out && out.comments.map((c) => c.id)).toEqual(["open-1"]);
		expect(pageSizes).toEqual(["100", "100"]);
		expect(action.formatMcp!(out)).toContain("Comments on angus:doc-1 (1 returned, 21 scanned)");
	});

	it("2. docs_comments list passes cursor through as cursor and page_size as limit", async () => {
		const tokens: Array<string | null> = [];
		const { config } = makeConfig((url) => {
			tokens.push(url.searchParams.get("pageToken"));
			return json({ comments: Array.from({ length: 5 }, (_, i) => ({ id: `c-${i}`, content: "open", resolved: false })), nextPageToken: "page-4" });
		});
		const out = await executeAction(createDocsCommentsAction(createGoogleDriveAdapter(config)), {
			document_id: "doc-1", domain: "work", action: "list", cursor: "page-3", page_size: 2, include_resolved: true,
		}, { context: { caller: "mcp" } });
		expect(tokens).toEqual(["page-3"]);
		expect(out).toMatchObject({ domain: "work", include_resolved: true, scanned: 5, next_cursor: "page-4" });
		expect("comments" in out && out.comments.map((c) => c.id)).toEqual(["c-0", "c-1"]);
	});

	it("3. maps only Google's stale-revision signature (400, INVALID_ARGUMENT, probe message) to 'Doc changed since your read'", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runBatch(rejecting(new DocsApiError(STALE, 400, "INVALID_ARGUMENT")))).rejects.toThrow(
				/Doc changed since your read \(revision mismatch: required 'rev-stale'\)\. Re-read the document with docs_get/,
			);
			const notMismatch = [
				new DocsApiError("Invalid requests[0].insertText: revision of the index must be less than the end index.", 400, "INVALID_ARGUMENT"),
				new DocsApiError(STALE, 400, "FAILED_PRECONDITION"),
				new Error("400 Bad Request: the revision is wrong"),
			];
			for (const err of notMismatch) {
				const thrown = await runBatch(rejecting(err)).catch((e: unknown) => e);
				expect(thrown).toBe(err);
			}
		} finally {
			errSpy.mockRestore();
		}
	});

	it("4. getDocument retries reads on 429 and 5xx at most twice", async () => {
		let calls = 0;
		const ok = makeConfig(() => (++calls === 1 ? json({ error: { code: 429, message: "Slow down" } }, 429) : json({ documentId: "doc-1", title: "T", revisionId: "rev-1", tabs: [] })));
		const out = await executeAction(createDocsGetAction(createGoogleDocsAdapter(ok.config)), { document_id: "doc-1", domain: "angus" }, { context: { caller: "mcp" } });
		expect([out.revisionId, calls, ok.sleeps]).toEqual(["rev-1", 2, [250]]);

		calls = 0;
		const down = makeConfig(() => { calls++; return json({ error: { code: 503, message: "Unavailable", status: "UNAVAILABLE" } }, 503); });
		await expect(executeAction(createDocsGetAction(createGoogleDocsAdapter(down.config)), { document_id: "doc-1", domain: "angus" }, { context: { caller: "mcp" } }))
			.rejects.toMatchObject({ status: 503 });
		expect([calls, down.sleeps]).toEqual([3, [250, 500]]);
	});

	it("5. batchUpdate answering 503 is called once and fails: a write never retries", async () => {
		let posts = 0;
		const { config, sleeps } = makeConfig(() => { posts++; return json({ error: { code: 503, message: "Unavailable", status: "UNAVAILABLE" } }, 503); });
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(runBatch(createGoogleDocsAdapter(config))).rejects.toMatchObject({ status: 503 });
		} finally {
			errSpy.mockRestore();
		}
		expect([posts, sleeps]).toEqual([1, []]);
	});
});

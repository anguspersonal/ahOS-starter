import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleDocsAdapter } from "../../adapters/google/docs/adapter.js";
import { executeAction } from "../adapters/direct.js";
import { createDocsAppendAction } from "./append.js";
import { createDocsBatchUpdateAction } from "./batchUpdate.js";
import { createDocsReplaceTextAction } from "./replaceText.js";

type Call = { method: string; path: string; body: Record<string, any> | undefined };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const STALE = "The required revision ID 'rev-stale' does not match the latest revision.";
const ctx = { context: { caller: "mcp" as const } };
const base = { document_id: "doc-1", domain: "angus" as const, required_revision_id: "rev-1" };

/** Real Docs adapter over a fake fetch; every non-token request is recorded. */
function harness(reply: () => Response) {
	const calls: Call[] = [];
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.href === "https://oauth2.googleapis.com/token") return json({ access_token: "tok-1" });
		calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return reply();
	}) as typeof fetch;
	const docs = createGoogleDocsAdapter({ clientId: "cid", clientSecret: "csec", refreshToken: async () => "rt", sleepFn: async () => {}, fetchFn });
	const artifacts = { appendDocEditAudit: vi.fn().mockResolvedValue(undefined) };
	const ports = { docs, artifacts };
	return {
		calls, artifacts,
		batchUpdates: () => calls.filter((c) => c.path.endsWith(":batchUpdate")),
		replace: (args: Record<string, unknown>) => executeAction(createDocsReplaceTextAction(ports), { ...base, find: "foo", replace: "bar", ...args }, ctx),
		append: (args: Record<string, unknown>) => executeAction(createDocsAppendAction(ports), { ...base, text: "hello", ...args }, ctx),
		batch: () => executeAction(createDocsBatchUpdateAction(ports), { ...base, required_revision_id: "rev-stale", requests: [{ insertText: { location: { index: 1 }, text: "x" } }] }, ctx),
	};
}
const ok = (replies: unknown[] = [{}]) => () => json({ documentId: "doc-1", replies, writeControl: { requiredRevisionId: "rev-2" } });
const stale = () => json({ error: { code: 400, message: STALE, status: "INVALID_ARGUMENT" } }, 400);
const forbidden = () => json({ error: { code: 403, message: "Suggestions are not allowed", status: "PERMISSION_DENIED" } }, 403);

describe("docs_replace_text and docs_append under the revision lock (#2311)", () => {
	let errSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
	afterEach(() => errSpy.mockRestore());

	it("1. docs_replace_text sends one replaceAllText under the lock and returns occurrences_changed and the new revision", async () => {
		const h = harness(ok([{ replaceAllText: { occurrencesChanged: 3 } }]));
		const out = await h.replace({});
		expect(h.calls).toHaveLength(1);
		expect(h.batchUpdates()[0]!.body).toEqual({
			requests: [{ replaceAllText: { containsText: { text: "foo", matchCase: true }, replaceText: "bar" } }],
			writeControl: { requiredRevisionId: "rev-1" },
		});
		expect(out).toMatchObject({ occurrences_changed: 3, revision_after: "rev-2" });

		const tabbed = harness(ok([{ replaceAllText: { occurrencesChanged: 1 } }]));
		await tabbed.replace({ tab_ids: ["t.1"], match_case: false });
		expect(tabbed.batchUpdates()[0]!.body!.requests[0].replaceAllText).toEqual({
			containsText: { text: "foo", matchCase: false }, replaceText: "bar", tabsCriteria: { tabIds: ["t.1"] },
		});
	});

	it("2. zero occurrences, or no count, is stated as no match", async () => {
		for (const replies of [[{ replaceAllText: { occurrencesChanged: 0 } }], [{ replaceAllText: {} }]]) {
			const out = await harness(ok(replies)).replace({});
			expect(out.occurrences_changed).toBe(0);
			expect(createDocsReplaceTextAction({ docs: {} as never }).formatMcp!(out)).toMatch(/^No match: "foo" was not found/);
		}
	});

	it("3. docs_append sends one insertText at endOfSegmentLocation, the text exactly as given, and no documents.get", async () => {
		const h = harness(ok());
		const out = await h.append({ text: "no newline" });
		expect(h.calls.map((c) => c.method)).toEqual(["POST"]);
		expect(h.batchUpdates()[0]!.body).toEqual({
			requests: [{ insertText: { endOfSegmentLocation: {}, text: "no newline" } }],
			writeControl: { requiredRevisionId: "rev-1" },
		});
		expect(out.revision_after).toBe("rev-2");

		const tabbed = harness(ok());
		await tabbed.append({ tab_id: "t.1" });
		expect(tabbed.batchUpdates()[0]!.body!.requests[0].insertText.endOfSegmentLocation).toEqual({ tabId: "t.1" });
	});

	it("4. without required_revision_id both helpers fail validation and call nothing", async () => {
		const h = harness(ok());
		await expect(h.replace({ required_revision_id: undefined })).rejects.toThrow();
		await expect(h.append({ required_revision_id: undefined })).rejects.toThrow();
		expect(h.calls).toHaveLength(0);
	});

	it("5. a stale revision maps to the same re-read message as docs_batch_update", async () => {
		const expected = await harness(stale).batch().catch((e: Error) => e.message);
		expect(expected).toMatch(/^Doc changed since your read \(revision mismatch: required 'rev-stale'\)\. Re-read/);
		for (const run of [(h: ReturnType<typeof harness>) => h.replace({ required_revision_id: "rev-stale" }), (h: ReturnType<typeof harness>) => h.append({ required_revision_id: "rev-stale" })]) {
			await expect(run(harness(stale))).rejects.toThrow(expected);
		}
	});

	it("6. each successful call writes one audit entry with request_count 1 and the suggest flag", async () => {
		for (const [run, suggest] of [["replace", undefined], ["replace", true], ["append", undefined], ["append", true]] as const) {
			const h = harness(ok([{ replaceAllText: { occurrencesChanged: 1 } }]));
			await h[run](suggest === undefined ? {} : { suggest });
			expect(h.artifacts.appendDocEditAudit).toHaveBeenCalledTimes(1);
			expect(h.artifacts.appendDocEditAudit).toHaveBeenCalledWith("doc-1", expect.objectContaining({
				revision_before: "rev-1", revision_after: "rev-2", request_count: 1, suggest: suggest === true,
			}));
		}
	});

	it.each(["replace", "append"] as const)("7-8. %s with suggest: true sends writeMode SUGGEST beside the lock and reports suggestion mode", async (run) => {
		const h = harness(ok([{ replaceAllText: { occurrencesChanged: 1 } }]));
		const out = await h[run]({ suggest: true });
		expect(h.batchUpdates()[0]!.body!.writeControl).toEqual({ requiredRevisionId: "rev-1", writeMode: "SUGGEST" });
		expect(out.suggest).toBe(true);
		const action = run === "replace" ? createDocsReplaceTextAction : createDocsAppendAction;
		expect(action({ docs: {} as never }).formatMcp!(out as never)).toContain("Mode: Suggestion (writeMode: 'SUGGEST')");
	});

	it.each(["replace", "append"] as const)("9. %s without suggest (omitted or false) never sends writeMode", async (run) => {
		for (const args of [{}, { suggest: false }]) {
			const h = harness(ok([{ replaceAllText: { occurrencesChanged: 1 } }]));
			await h[run](args);
			expect(h.batchUpdates()[0]!.body!.writeControl).toEqual({ requiredRevisionId: "rev-1" });
		}
	});

	it.each(["replace", "append"] as const)("10. %s: a refused suggest write returns the never-fall-back error, calls batchUpdate once, writes no audit", async (run) => {
		const h = harness(forbidden);
		await expect(h[run]({ suggest: true })).rejects.toThrow(
			/^Google refused suggestion mode \(suggest: true\): .*The edits were NOT applied, and ahKMS will never fall back to a direct edit\.$/,
		);
		expect(h.batchUpdates()).toHaveLength(1);
		expect(h.calls).toHaveLength(1);
		expect(h.artifacts.appendDocEditAudit).not.toHaveBeenCalled();
	});

	it("11. docs_replace_text rejects an empty tab_ids array and makes no API call", async () => {
		const h = harness(ok());
		await expect(h.replace({ tab_ids: [] })).rejects.toThrow(/tab_ids/);
		expect(h.calls).toHaveLength(0);
	});
});

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, setDefaultAuditSink, sha256Hex, stderrAuditSink, type ActionAuditRecord, type DiscoverCounts } from "@ahkms/core";

const mocks = vi.hoisted(() => {
	class CredentialNotConfiguredError extends Error {
		constructor(message: string) { super(message); this.name = "CredentialNotConfiguredError"; }
	}
	return {
		CredentialNotConfiguredError, ownerId: "11111111-1111-4111-8111-111111111111",
		searchNotion: vi.fn(), notionResultTitle: vi.fn((r: { id: string }) => `title-${r.id}`),
		getDrive: vi.fn(), getCredential: vi.fn(), recordRun: vi.fn(), maybeSingle: vi.fn(),
		getGmailAccessToken: vi.fn(), getMessage: vi.fn(), getProfile: vi.fn(), listMessageIds: vi.fn(),
		scheduleEnv: { gmailAttachmentDiscoverEnabled: true, gmailAttachmentDiscoverMaxMessages: 1000 },
	};
});

vi.mock("../identity.js", () => ({ getCurrentUserId: () => mocks.ownerId }));
vi.mock("../notion.js", () => ({ searchNotion: (...a: unknown[]) => mocks.searchNotion(...a), notionResultTitle: (r: { id: string }) => mocks.notionResultTitle(r) }));
vi.mock("../google/drive.js", async (orig) => ({ ...(await orig<typeof import("../google/drive.js")>()), getDrive: (...a: unknown[]) => mocks.getDrive(...a) }));
vi.mock("../credentials.js", () => ({ getCredential: (...a: unknown[]) => mocks.getCredential(...a), getGithubCredential: vi.fn(), hasCredential: vi.fn(async () => false), CredentialNotConfiguredError: mocks.CredentialNotConfiguredError }));
vi.mock("../schedule/runLog.js", () => ({ recordRun: (...a: unknown[]) => mocks.recordRun(...a) }));
vi.mock("../schedule/env.js", () => ({ env: mocks.scheduleEnv }));
vi.mock("../backoff.js", async (orig) => ({ ...(await orig<typeof import("../backoff.js")>()), withBackoff: (fn: () => unknown) => fn() }));
vi.mock("../google/gmail.js", async (orig) => ({ ...(await orig<typeof import("../google/gmail.js")>()), getGmailAccessToken: (...a: unknown[]) => mocks.getGmailAccessToken(...a), getMessage: (...a: unknown[]) => mocks.getMessage(...a), getProfile: (...a: unknown[]) => mocks.getProfile(...a), listMessageIds: (...a: unknown[]) => mocks.listMessageIds(...a) }));
vi.mock("../supabase.js", () => {
	const chain: Record<string, unknown> = { maybeSingle: () => mocks.maybeSingle() };
	for (const m of ["select", "order", "limit", "eq", "not"]) chain[m] = () => chain;
	return { supabase: { from: () => chain } };
});

import { ingestDiscoverAction } from "../tools/discover.js";
import { runNotionDiscoverCadence } from "../schedule/notionDiscoverCadence.js";
import { runDriveDiscoverCadence } from "../schedule/driveDiscoverCadence.js";
import { runGmailAttachmentDiscoverCadence } from "../schedule/gmailAttachmentDiscoverCadence.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const counts = (over: Partial<DiscoverCounts> = {}): DiscoverCounts => ({ inserted: 0, updated: 0, unchanged: 0, refreshed: 0, skipped: 0, excluded: 0, embedded: 0, embeddable: 0, ...over });

describe("discover cadences invoke ingest_discover via executeAction (#1626)", () => {
	let auditRecords: ActionAuditRecord[];
	const discoverAction = ingestDiscoverAction;

	beforeEach(() => {
		vi.clearAllMocks();
		auditRecords = [];
		setDefaultAuditSink((r) => { auditRecords.push(r); });
		mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
		mocks.recordRun.mockResolvedValue(undefined);
		mocks.getCredential.mockImplementation(async (k: string) => {
			if (k === "notion_work" || k === "google_personal") return `tok-${k}`;
			throw new mocks.CredentialNotConfiguredError(`${k} not set`);
		});
		mocks.searchNotion.mockResolvedValue({ results: [{ id: "n1", object: "page", url: "https://notion.so/n1", created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-07-01T00:00:00.000Z" }], next_cursor: null, has_more: false });
		mocks.getDrive.mockResolvedValue({ files: { list: vi.fn(async (p?: { q?: string }) => ({ data: { files: String(p?.q ?? "").includes("trashed = true") ? [] : [{ id: "d1", name: "Doc.pdf", mimeType: "application/pdf", modifiedTime: "2026-08-01T00:00:00.000Z" }] } })) } });
		mocks.getGmailAccessToken.mockResolvedValue("access-personal");
		mocks.getProfile.mockResolvedValue({ emailAddress: "owner@example.com", messagesTotal: 1 });
		mocks.listMessageIds.mockResolvedValue({ ids: ["m1"], nextPageToken: null });
		mocks.getMessage.mockResolvedValue({ id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: String(Date.parse("2023-11-03T10:17:52.000Z")), payload: { partId: "", mimeType: "multipart/mixed", filename: "", headers: [{ name: "From", value: "Owner <owner@example.com>" }, { name: "Date", value: "Fri, 3 Nov 2023 10:17:52 +0000" }], parts: [{ partId: "1", mimeType: "application/pdf", filename: "cv.pdf", headers: [{ name: "Content-Disposition", value: 'attachment; filename="cv.pdf"' }], body: { size: 1001, attachmentId: "a1" } }] } });
	});

	afterEach(() => { setDefaultAuditSink(stderrAuditSink); vi.restoreAllMocks(); });

	it("Notion cadence runs ingest_discover via executeAction with caller worker, owner userId, and records action counts", async () => {
		const spy = vi.spyOn(discoverAction, "run").mockResolvedValue(counts({ inserted: 3, updated: 2, unchanged: 1 }));
		await runNotionDiscoverCadence();
		const input = { connector: "notion", items: [{ external_id: "n1", title: "title-n1", url: "https://notion.so/n1", source_created_at: "2026-01-01T00:00:00.000Z", source_modified_at: "2026-07-01T00:00:00.000Z", content_hash: "2026-07-01T00:00:00.000Z" }] };
		expect(spy).toHaveBeenCalledWith(input, expect.objectContaining({ caller: "worker", userId: mocks.ownerId }));
		expect(auditRecords).toEqual([expect.objectContaining({ actionId: "ingest_discover", caller: "worker", userId: mocks.ownerId, outcome: "success", inputSha256: await sha256Hex(canonicalJson(input)) })]);
		expect(mocks.recordRun).toHaveBeenCalledWith(expect.objectContaining({ connector: "notion", counts: { scanned: 1, new: 3, changed: 2, unchanged: 1, trashed: 0, workspaces: 1, errors: 0 } }));
	});

	it("Drive cadence runs ingest_discover via executeAction with caller worker, owner userId, and records action counts", async () => {
		const spy = vi.spyOn(discoverAction, "run").mockResolvedValue(counts({ inserted: 4, updated: 1, unchanged: 2, refreshed: 1 }));
		await runDriveDiscoverCadence();
		const input = { connector: "gdrive", items: [{ external_id: "d1", title: "Doc.pdf", mime_type: "application/pdf", source_modified_at: "2026-08-01T00:00:00.000Z", content_hash: "2026-08-01T00:00:00.000Z" }] };
		expect(spy).toHaveBeenCalledWith(input, expect.objectContaining({ caller: "worker", userId: mocks.ownerId }));
		expect(auditRecords).toEqual([expect.objectContaining({ actionId: "ingest_discover", caller: "worker", userId: mocks.ownerId, outcome: "success", inputSha256: await sha256Hex(canonicalJson(input)) })]);
		expect(mocks.recordRun).toHaveBeenCalledWith(expect.objectContaining({ connector: "gdrive", counts: { scanned: 1, new: 4, changed: 1, unchanged: 2, refreshed: 1 } }));
	});

	it("Gmail attachment cadence runs ingest_discover via executeAction with caller worker, owner userId, and records action counts", async () => {
		const spy = vi.spyOn(discoverAction, "run").mockResolvedValue(counts({ inserted: 5, updated: 2, unchanged: 3, skipped: 1 }));
		await runGmailAttachmentDiscoverCadence();
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ connector: "gmail_attachment", items: [expect.objectContaining({ external_id: "m1:1", title: "cv.pdf" })] }), expect.objectContaining({ caller: "worker", userId: mocks.ownerId }));
		expect(auditRecords).toEqual([expect.objectContaining({ actionId: "ingest_discover", caller: "worker", userId: mocks.ownerId, outcome: "success" })]);
		expect(mocks.recordRun).toHaveBeenCalledWith(expect.objectContaining({ connector: "gmail_attachment", counts: expect.objectContaining({ new: 5, changed: 2, unchanged: 3, skipped: 1 }) }));
	});

	it("records an action error as a failed run across all three cadences", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(discoverAction, "run").mockRejectedValue(new Error("action failure"));
		await runNotionDiscoverCadence();
		await runDriveDiscoverCadence();
		await runGmailAttachmentDiscoverCadence();
		expect(auditRecords).toHaveLength(3);
		for (const r of auditRecords) expect(r).toMatchObject({ actionId: "ingest_discover", caller: "worker", userId: mocks.ownerId, outcome: "error", errorMessage: "action failure" });
		expect(mocks.recordRun.mock.calls.map((c) => c[0])).toEqual([
			expect.objectContaining({ connector: "notion", error: expect.stringContaining("action failure") }),
			expect.objectContaining({ connector: "gdrive", error: expect.stringContaining("action failure") }),
			expect.objectContaining({ connector: "gmail_attachment", error: expect.stringContaining("action failure") }),
		]);
	});

	it("leaves zero references to the removed shim in packages/mcp-server/src", () => {
		const removedShim = ["discover", "Items"].join("");
		let grepOut = "";
		try {
			grepOut = execFileSync("grep", ["-rn", removedShim, "packages/mcp-server/src"], { cwd: repoRoot, encoding: "utf-8" });
		} catch (err: unknown) {
			if ((err as { status?: number }).status !== 1) throw err;
		}
		expect(grepOut).toBe("");
	});
});

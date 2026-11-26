import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveApiError, type DrivePort } from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { PendingApprovalError, setActionApprovalStore } from "../gate.js";
import type { ActionAuditRecord } from "../types.js";
import {
	createDriveRevisionDeleteAction, createDriveRevisionGetAction,
	createDriveRevisionKeepAction, createDriveRevisionListAction,
} from "./revisions.js";

const SAMPLE_REV = {
	id: "rev-1", modifiedTime: "2026-04-01T12:00:00Z",
	lastModifyingUser: { displayName: "Angus", emailAddress: "owner@example.com" },
	keepForever: false, size: "128", md5Checksum: "abc123",
	mimeType: "text/plain", originalFilename: "notes.txt",
};

function makePort(overrides: Partial<DrivePort> = {}): DrivePort {
	return {
		getFile: vi.fn(), listFiles: vi.fn(), listPermissions: vi.fn(), uploadFile: vi.fn(),
		downloadFile: vi.fn(), exportFile: vi.fn(), trashFile: vi.fn(),
		listRevisions: vi.fn().mockResolvedValue({ revisions: [SAMPLE_REV], nextPageToken: "cursor-2" }),
		getRevision: vi.fn().mockResolvedValue(SAMPLE_REV),
		downloadRevision: vi.fn().mockResolvedValue(new TextEncoder().encode("hello world")),
		updateRevision: vi.fn().mockResolvedValue({ ...SAMPLE_REV, keepForever: true }),
		deleteRevision: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("drive revision actions (#1647)", () => {
	afterEach(() => setActionApprovalStore(undefined));

	it("caller mcp: drive_revision_delete parks (pending_approval) without calling the port, while list, get, and keep execute", async () => {
		const port = makePort();
		setActionApprovalStore({ park: vi.fn().mockResolvedValue({ decisionId: "appr-rev-1" }) });
		const audits: ActionAuditRecord[] = [];
		const opts = { context: { caller: "mcp" as const }, auditSink: (r: ActionAuditRecord) => audits.push(r) };

		const listOut = await executeAction(createDriveRevisionListAction(port), { domain: "work", file_id: "file-1" }, opts);
		const getOut = await executeAction(createDriveRevisionGetAction(port), { domain: "work", file_id: "file-1", revision_id: "rev-1" }, opts);
		const keepOut = await executeAction(createDriveRevisionKeepAction(port), { domain: "work", file_id: "file-1", revision_id: "rev-1", keep_forever: true }, opts);
		await expect(
			executeAction(createDriveRevisionDeleteAction(port), { domain: "work", file_id: "file-1", revision_id: "rev-1" }, opts),
		).rejects.toThrow(PendingApprovalError);

		expect(listOut.revisions[0]).toEqual({
			id: "rev-1", modified_at: "2026-04-01T12:00:00Z", last_modifying_user: "Angus",
			keep_forever: false, size: 128, md5: "abc123", mime_type: "text/plain", original_filename: "notes.txt",
		});
		expect([listOut.next_cursor, getOut.id, keepOut.keep_forever]).toEqual(["cursor-2", "rev-1", true]);
		expect(audits.map((a) => a.outcome)).toEqual(["success", "success", "success", "pending_approval"]);
		expect(port.deleteRevision).not.toHaveBeenCalled();
	});

	it("drive_revision_keep on application/vnd.google-apps.document refuses with binary-only reason before any write", async () => {
		const port = makePort({
			getRevision: vi.fn().mockResolvedValue({ id: "rev-doc", mimeType: "application/vnd.google-apps.document" }),
		});
		await expect(
			executeAction(createDriveRevisionKeepAction(port), { domain: "angus", file_id: "doc-1", revision_id: "rev-doc", keep_forever: true }, { context: { caller: "mcp" } }),
		).rejects.toThrow(/supports binary files only.*application\/vnd\.google-apps\.document/);
		expect(port.updateRevision).not.toHaveBeenCalled();
	});

	it("drive_revision_get with include_text on a PNG revision returns readable: false with a reason", async () => {
		const port = makePort({
			getRevision: vi.fn().mockResolvedValue({ id: "rev-png", mimeType: "image/png", originalFilename: "diagram.png", size: "4096" }),
		});
		const out = await executeAction(
			createDriveRevisionGetAction(port),
			{ domain: "work", file_id: "img-1", revision_id: "rev-png", include_text: true },
			{ context: { caller: "mcp" } },
		);
		expect([out.readable, out.text, out.reason?.includes("image/png")]).toEqual([false, undefined, true]);
		expect(port.downloadRevision).not.toHaveBeenCalled();
	});

	it("drive_revision_get cuts a 30,000-character export to 20,000 with truncated: true and receipt-only formatMcp", async () => {
		const exportUrl = "https://docs.google.com/feeds/download/documents/export/Export?id=doc-1&revision=rev-9&exportFormat=txt";
		const port = makePort({
			getRevision: vi.fn().mockResolvedValue({ id: "rev-9", mimeType: "application/vnd.google-apps.document", exportLinks: { "text/plain": exportUrl } }),
			downloadRevision: vi.fn().mockResolvedValue(new TextEncoder().encode("x".repeat(30_000))),
		});
		const action = createDriveRevisionGetAction(port);
		const out = await executeAction(action, { domain: "work", file_id: "doc-1", revision_id: "rev-9", include_text: true }, { context: { caller: "mcp" } });
		expect([out.readable, out.truncated, out.total_chars, out.text?.length]).toEqual([true, true, 30_000, 20_000]);
		const mcpReceipt = action.formatMcp?.(out) ?? "";
		expect([mcpReceipt.includes("chars=20000/30000, truncated=true"), mcpReceipt.includes("xxxx")]).toEqual([true, false]);
		expect(port.downloadRevision).toHaveBeenCalledWith({ domain: "work", fileId: "doc-1", revisionId: "rev-9", exportUrl });
	});

	it("maps HTTP 400 on deleting the last revision and HTTP 403 on keeping >200 pinned revisions to stated messages", async () => {
		const port = makePort({
			deleteRevision: vi.fn().mockRejectedValue(new DriveApiError("Cannot delete the only revision", 400, "cannotDeleteOnlyRevision")),
			updateRevision: vi.fn().mockRejectedValue(new DriveApiError("Too many pinned revisions", 403, "numKeepForeverRevisionsExceeded")),
		});
		await expect(
			executeAction(createDriveRevisionDeleteAction(port), { domain: "angus", file_id: "file-1", revision_id: "rev-last" }, { context: { caller: "ui" } }),
		).rejects.toThrow("Google Drive refuses to delete the last remaining revision of a file (HTTP 400). Trash the file itself to remove it.");
		await expect(
			executeAction(createDriveRevisionKeepAction(port), { domain: "angus", file_id: "file-1", revision_id: "rev-201", keep_forever: true }, { context: { caller: "mcp" } }),
		).rejects.toThrow("Google Drive allows at most 200 pinned (keepForever) revisions per file (HTTP 403). Unpin an older revision before pinning another.");
	});
});

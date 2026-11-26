import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateDriveFileParams, DriveFile, DriveFileMedia, DrivePort } from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import {
	createDriveExportAction,
	isExportSizeLimitError,
	type DriveExportInput,
} from "./export.js";

/**
 * drive_export (#1220, #1592): a Google Doc rendered to PDF or DOCX and written back to
 * Drive as a new file beside the source, with its link returned.
 */

const filesGet = vi.fn();
const filesExport = vi.fn();
const filesCreate = vi.fn();
const countDocumentTabs = vi.fn();

const port = {
	getFile: filesGet,
	exportFile: filesExport,
	createFile: filesCreate,
	countDocumentTabs,
} as unknown as DrivePort;

const action = createDriveExportAction(port);

async function driveExportHandler(args: DriveExportInput) {
	const out = await executeAction(action, args, { context: { caller: "mcp" } });
	return { content: [{ type: "text" as const, text: action.formatMcp!(out) }] };
}

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type CreateCall = {
	requestBody: Record<string, unknown>;
	media: DriveFileMedia;
};

function lastCreate(): CreateCall {
	const p = filesCreate.mock.calls.at(-1)?.[0] as CreateDriveFileParams;
	return {
		requestBody: {
			name: p.name,
			mimeType: p.mimeType,
			parents: p.parents,
		},
		media: p.media!,
	};
}

function sourceDoc(overrides: Partial<DriveFile> = {}): DriveFile {
	return {
		id: "doc-1",
		name: "Angus Hally CV",
		mimeType: "application/vnd.google-apps.document",
		parents: ["folder-cv"],
		webViewLink: "https://docs.google.com/document/d/doc-1/edit",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	countDocumentTabs.mockResolvedValue(1);
	filesGet.mockResolvedValue(sourceDoc());
	filesExport.mockImplementation(
		async ({ mimeType }: { mimeType: string }) => new TextEncoder().encode(`bytes-as-${mimeType}`),
	);
	filesCreate.mockImplementation(async (params: CreateDriveFileParams) => ({
		id: "export-1",
		name: params.name,
		mimeType: params.mimeType,
		parents: params.parents,
		webViewLink: "https://drive.google.com/file/d/export-1/view",
	}));
});

describe("drive_export", () => {
	it("exports a Doc to PDF and saves it beside the source", async () => {
		const res = await driveExportHandler({ file_id: "doc-1", format: "pdf" });

		expect(filesExport).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "doc-1",
			mimeType: PDF,
		});
		const call = lastCreate();
		expect(call.requestBody).toEqual({
			name: "Angus Hally CV.pdf",
			mimeType: PDF,
			parents: ["folder-cv"],
		});
		expect(call.media.mimeType).toBe(PDF);
		expect(new TextDecoder().decode(call.media.body as Uint8Array)).toBe(`bytes-as-${PDF}`);

		const text = res.content[0].text;
		expect(text).toContain(`Exported "Angus Hally CV" to PDF (${`bytes-as-${PDF}`.length} bytes)`);
		expect(text).toContain("beside the source, in the same folder");
		expect(text).toContain("Link: https://drive.google.com/file/d/export-1/view");
		expect(text).toContain("Source Doc (unchanged): https://docs.google.com/document/d/doc-1/edit");
	});

	it("exports a Doc to DOCX with the Word type and extension", async () => {
		await driveExportHandler({ file_id: "doc-1", format: "docx" });

		expect(filesExport).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "doc-1",
			mimeType: DOCX,
		});
		expect(lastCreate().requestBody).toEqual({
			name: "Angus Hally CV.docx",
			mimeType: DOCX,
			parents: ["folder-cv"],
		});
		expect(lastCreate().media.mimeType).toBe(DOCX);
	});

	it("honours an explicit name and parent_id", async () => {
		const res = await driveExportHandler({
			file_id: "doc-1",
			format: "pdf",
			name: "CV 2026-09.pdf",
			parent_id: "folder-out",
		});

		expect(lastCreate().requestBody).toMatchObject({ name: "CV 2026-09.pdf", parents: ["folder-out"] });
		expect(res.content[0].text).toContain("in folder folder-out");
	});

	it("appends the format's extension to an explicit name that lacks it", async () => {
		// Without it, a PDF called "CV 2026-09" downloads from an emailed link as a file
		// with no extension.
		await driveExportHandler({ file_id: "doc-1", format: "pdf", name: "CV 2026-09" });
		expect(lastCreate().requestBody.name).toBe("CV 2026-09.pdf");

		await driveExportHandler({ file_id: "doc-1", format: "docx", name: "CV.pdf" });
		expect(lastCreate().requestBody.name).toBe("CV.pdf.docx");

		await driveExportHandler({ file_id: "doc-1", format: "docx", name: "CV.DOCX" });
		expect(lastCreate().requestBody.name).toBe("CV.DOCX");
	});

	it("does not double the extension when the Doc's name already carries it", async () => {
		filesGet.mockResolvedValue(sourceDoc({ name: "Report.PDF" }));

		await driveExportHandler({ file_id: "doc-1", format: "pdf" });

		expect(lastCreate().requestBody.name).toBe("Report.PDF");
	});

	it("says so when the export lands in My Drive root for want of a visible parent", async () => {
		filesGet.mockResolvedValue(sourceDoc({ parents: undefined }));

		const res = await driveExportHandler({ file_id: "doc-1", format: "pdf" });

		expect(lastCreate().requestBody.parents).toBeUndefined();
		expect(res.content[0].text).toContain("in My Drive root");
	});

	it("passes the account through to the Drive client and the tab count", async () => {
		await driveExportHandler({ file_id: "doc-1", format: "pdf", account: "work" });

		expect(filesGet).toHaveBeenCalledWith({
			domain: "work",
			fileId: "doc-1",
			fields: "id, name, mimeType, parents, webViewLink",
		});
		expect(countDocumentTabs).toHaveBeenCalledWith({ domain: "work", fileId: "doc-1" });
	});

	it("says nothing about tabs for a single-tab Doc", async () => {
		const res = await driveExportHandler({ file_id: "doc-1", format: "pdf" });

		expect(res.content[0].text).not.toMatch(/Warning:|could not count/);
	});

	it("warns that the file is partial when the Doc has several tabs", async () => {
		countDocumentTabs.mockResolvedValue(3);

		const res = await driveExportHandler({ file_id: "doc-1", format: "pdf" });

		// Still exported: the warning qualifies the file, it does not refuse it.
		expect(filesCreate).toHaveBeenCalledTimes(1);
		expect(res.content[0].text).toContain(
			"Warning: only the default tab was exported. This Doc has 3 tabs, and Drive's export renders the default tab only; the other 2 tabs are not in this file.",
		);
	});

	it("still exports, with the general caveat, when the tab count fails", async () => {
		countDocumentTabs.mockRejectedValue(new Error("Google Docs API GET doc-1 (tab count) failed (500)"));

		const res = await driveExportHandler({ file_id: "doc-1", format: "pdf" });

		expect(filesCreate).toHaveBeenCalledTimes(1);
		expect(res.content[0].text).toContain("Note: could not count this Doc's tabs.");
	});

	it("refuses anything that is not a Google Doc, and writes nothing", async () => {
		filesGet.mockResolvedValue(sourceDoc({ name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }));

		await expect(driveExportHandler({ file_id: "doc-1", format: "pdf" })).rejects.toThrow(
			/Google Docs only; doc-1 \("Budget"\) is application\/vnd\.google-apps\.spreadsheet\. Nothing was written/,
		);
		expect(countDocumentTabs).not.toHaveBeenCalled();
		expect(filesExport).not.toHaveBeenCalled();
		expect(filesCreate).not.toHaveBeenCalled();
	});

	it("names a folder as a folder in the refusal", async () => {
		filesGet.mockResolvedValue(sourceDoc({ mimeType: "application/vnd.google-apps.folder" }));

		await expect(driveExportHandler({ file_id: "doc-1", format: "docx" })).rejects.toThrow(/is a folder/);
	});

	it("turns Drive's export size refusal into an explicit error and writes nothing", async () => {
		// The shape googleapis raises: a 403 whose reason is exportSizeLimitExceeded.
		filesExport.mockRejectedValue(
			Object.assign(new Error("This file is too large to be exported."), {
				status: 403,
				errors: [{ reason: "exportSizeLimitExceeded", message: "This file is too large to be exported." }],
			}),
		);

		await expect(driveExportHandler({ file_id: "doc-1", format: "pdf" })).rejects.toThrow(
			/over Drive's 10 MB export limit\. Nothing was written/,
		);
		expect(filesCreate).not.toHaveBeenCalled();
	});

	it("rethrows any other export failure unchanged", async () => {
		const boom = new Error("Backend Error");
		filesExport.mockRejectedValue(boom);

		await expect(driveExportHandler({ file_id: "doc-1", format: "pdf" })).rejects.toBe(boom);
		expect(filesCreate).not.toHaveBeenCalled();
	});
});

describe("isExportSizeLimitError", () => {
	it("finds the reason in the parsed errors array", () => {
		expect(isExportSizeLimitError({ errors: [{ reason: "exportSizeLimitExceeded" }] })).toBe(true);
	});

	it("finds the reason in the response body gaxios parsed back from the arraybuffer", () => {
		// gaxios 6 re-parses an arraybuffer error body into JSON on a best-effort basis.
		const data = { error: { code: 403, errors: [{ reason: "exportSizeLimitExceeded" }] } };
		expect(isExportSizeLimitError({ message: "Request failed", response: { data } })).toBe(true);
	});

	it("finds the reason in a raw arraybuffer error body", () => {
		// With responseType 'arraybuffer' the JSON error body can arrive unparsed.
		const body = new TextEncoder().encode(
			JSON.stringify({ error: { code: 403, errors: [{ reason: "exportSizeLimitExceeded" }] } }),
		).buffer;
		expect(isExportSizeLimitError({ message: "Request failed", response: { data: body } })).toBe(true);
	});

	it("is false for other failures and for non-objects", () => {
		expect(isExportSizeLimitError(new Error("Backend Error"))).toBe(false);
		expect(isExportSizeLimitError({ errors: [{ reason: "notFound" }] })).toBe(false);
		expect(isExportSizeLimitError(undefined)).toBe(false);
		expect(isExportSizeLimitError("exportSizeLimitExceeded")).toBe(false);
	});
});

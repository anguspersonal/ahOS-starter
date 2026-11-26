import { describe, expect, it, vi } from "vitest";
import { createGoogleDriveAdapter } from "../../adapters/google/drive/index.js";
import { OFFICE_OPEN_XML_MIMES } from "../../domain/extract/office.js";
import type { DrivePort } from "../../ports/drive.js";
import { createDriveReadFileAction } from "./readFile.js";

function buildStoredZipBytes(entries: { name: string; content: string }[]): Uint8Array {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	let totalLen = 0;
	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const dataBytes = encoder.encode(entry.content);
		const record = new Uint8Array(30 + nameBytes.byteLength + dataBytes.byteLength);
		const view = new DataView(record.buffer);
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, 20, true);
		view.setUint16(8, 0, true);
		view.setUint32(18, dataBytes.byteLength, true);
		view.setUint32(22, dataBytes.byteLength, true);
		view.setUint16(26, nameBytes.byteLength, true);
		record.set(nameBytes, 30);
		record.set(dataBytes, 30 + nameBytes.byteLength);
		chunks.push(record);
		totalLen += record.byteLength;
	}
	const out = new Uint8Array(totalLen);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

describe("createDriveReadFileAction (#1590)", () => {
	it("reads a 2-tab Google Doc and a 2-sheet Google Spreadsheet via DrivePort.downloadFile with both tabs/sheets rendered", async () => {
		const adapter = createGoogleDriveAdapter({
			clientId: "cid",
			clientSecret: "csec",
			refreshToken: async () => "rt",
			fetchFn: async (input) => {
				const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
				if (url.hostname === "oauth2.googleapis.com") {
					return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
				}
				if (url.pathname === "/drive/v3/files/doc-2tabs") {
					return new Response(
						JSON.stringify({
							id: "doc-2tabs",
							name: "Strategy Doc",
							mimeType: "application/vnd.google-apps.document",
						}),
						{ status: 200 },
					);
				}
				if (url.hostname === "docs.googleapis.com") {
					return new Response(
						JSON.stringify({
							documentId: "doc-2tabs",
							title: "Strategy Doc",
							tabs: [
								{
									tabProperties: { tabId: "t1", title: "Overview" },
									documentTab: {
										body: { content: [{ paragraph: { elements: [{ textRun: { content: "Tab one text\n" } }] } }] },
									},
								},
								{
									tabProperties: { tabId: "t2", title: "Details" },
									documentTab: {
										body: { content: [{ paragraph: { elements: [{ textRun: { content: "Tab two text\n" } }] } }] },
									},
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.pathname === "/drive/v3/files/sheet-2tabs") {
					return new Response(
						JSON.stringify({
							id: "sheet-2tabs",
							name: "KPI Sheet",
							mimeType: "application/vnd.google-apps.spreadsheet",
						}),
						{ status: 200 },
					);
				}
				if (url.hostname === "sheets.googleapis.com" && url.pathname.endsWith("/values:batchGet")) {
					return new Response(
						JSON.stringify({
							spreadsheetId: "sheet-2tabs",
							valueRanges: [
								{ range: "'Revenue'!A1:B1", values: [["Month", "MRR"]] },
								{ range: "'Costs'!A1:B1", values: [["Item", "Amount"]] },
							],
						}),
						{ status: 200 },
					);
				}
				if (url.hostname === "sheets.googleapis.com") {
					return new Response(
						JSON.stringify({
							spreadsheetId: "sheet-2tabs",
							properties: { title: "KPI Sheet" },
							sheets: [
								{ properties: { sheetId: 0, title: "Revenue", index: 0, hidden: false, sheetType: "GRID" } },
								{ properties: { sheetId: 1, title: "Costs", index: 1, hidden: false, sheetType: "GRID" } },
							],
						}),
						{ status: 200 },
					);
				}
				throw new Error(`Unexpected URL: ${url.toString()}`);
			},
		});

		const action = createDriveReadFileAction(adapter);
		const docOut = await action.run({ file_id: "doc-2tabs" }, {});
		expect(action.formatMcp!(docOut)).toBe(
			"Strategy Doc (application/vnd.google-apps.document):\n\n## Overview\n\nTab one text\n\n## Details\n\nTab two text",
		);

		const sheetOut = await action.run({ file_id: "sheet-2tabs", account: "work" }, {});
		expect(action.formatMcp!(sheetOut)).toContain("KPI Sheet (application/vnd.google-apps.spreadsheet):");
		expect(action.formatMcp!(sheetOut)).toContain("## Revenue\n\n```csv\nMonth,MRR\n```");
		expect(action.formatMcp!(sheetOut)).toContain("## Costs\n\n```csv\nItem,Amount\n```");
	});

	it("refuses Google Slides, unexportable Google types, and binary PDF files with exact pointer to ingest_drive", async () => {
		const downloadFile = vi.fn();
		const getFile = vi.fn();
		const port = { getFile, downloadFile } as unknown as DrivePort;
		const action = createDriveReadFileAction(port);

		getFile.mockResolvedValueOnce({
			id: "slides-1",
			name: "Pitch Deck",
			mimeType: "application/vnd.google-apps.presentation",
		});
		const slidesOut = await action.run({ file_id: "slides-1" }, {});
		expect(action.formatMcp!(slidesOut)).toBe(
			`"Pitch Deck" is a Google-native type (application/vnd.google-apps.presentation) that can't be exported as text. Use ingest_drive instead.`,
		);

		getFile.mockResolvedValueOnce({
			id: "form-1",
			name: "Survey",
			mimeType: "application/vnd.google-apps.form",
		});
		const formOut = await action.run({ file_id: "form-1" }, {});
		expect(action.formatMcp!(formOut)).toBe(
			`"Survey" is a Google-native type (application/vnd.google-apps.form) that can't be exported as text. Use ingest_drive instead.`,
		);

		getFile.mockResolvedValueOnce({
			id: "pdf-1",
			name: "Report.pdf",
			mimeType: "application/pdf",
		});
		const pdfOut = await action.run({ file_id: "pdf-1" }, {});
		expect(action.formatMcp!(pdfOut)).toBe(
			`"Report.pdf" is binary (application/pdf) and can't be read as text. Use ingest_drive to bring it into the knowledge store, then artifact_extract_text.`,
		);
		expect(downloadFile).not.toHaveBeenCalled();
	});

	it("truncates at max_chars with exact suffix and extracts .docx, .xlsx, and .pptx (#1590, #2084)", async () => {
		const getFile = vi.fn();
		const downloadFile = vi.fn();
		const port = { getFile, downloadFile } as unknown as DrivePort;
		const action = createDriveReadFileAction(port);

		const longText = "a".repeat(250);
		getFile.mockResolvedValueOnce({
			id: "txt-1",
			name: "Notes.txt",
			mimeType: "text/plain",
		});
		downloadFile.mockResolvedValueOnce({
			bytes: new TextEncoder().encode(longText),
			mimeType: "text/plain",
			extension: null,
		});
		const truncatedOut = await action.run({ file_id: "txt-1", max_chars: 100 }, {});
		expect(truncatedOut.truncated).toBe(true);
		expect(action.formatMcp!(truncatedOut)).toBe(
			`Notes.txt (text/plain):\n\n${"a".repeat(100)}\n\n… [truncated at 100 chars of 250]`,
		);

		const docxBytes = buildStoredZipBytes([
			{
				name: "word/document.xml",
				content: `<w:document><w:body><w:p><w:r><w:t>Contract clause 1</w:t></w:r></w:p></w:body></w:document>`,
			},
		]);
		getFile.mockResolvedValueOnce({
			id: "file-docx",
			name: "Agreement.docx",
			mimeType: OFFICE_OPEN_XML_MIMES.docx,
		});
		downloadFile.mockResolvedValueOnce({
			bytes: docxBytes,
			mimeType: OFFICE_OPEN_XML_MIMES.docx,
			extension: null,
		});
		const docxOut = await action.run({ file_id: "file-docx" }, {});
		expect(action.formatMcp!(docxOut)).toContain(
			`Agreement.docx (${OFFICE_OPEN_XML_MIMES.docx}):\n\nContract clause 1`,
		);
	});
});

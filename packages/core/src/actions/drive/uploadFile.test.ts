import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DriveApiError,
	FILE_FIELDS,
	GOOGLE_DOC_MIME_TYPE,
	type DriveFile,
	type DrivePort,
	type LocalFileReader,
	type UploadDriveFileParams,
} from "../../ports/drive.js";
import { executeAction } from "../adapters/direct.js";
import { createDriveUploadFileAction } from "./uploadFile.js";

/**
 * drive_upload_file core action and optional Google Doc conversion (#1220, #1471).
 *
 * Drive converts on upload when the file's target type (targetMimeType) is
 * the Docs type while the media keeps its own type. With convert_to, the target
 * type is set and the media type is the real source format; without it, the
 * request has no targetMimeType key at all on the metadata.
 */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const uploadFile = vi.fn<
	(params: UploadDriveFileParams) => Promise<DriveFile>
>();

function makePort(): DrivePort {
	return {
		getFile: vi.fn(),
		listFiles: vi.fn(),
		listPermissions: vi.fn(),
		createFile: vi.fn(),
		copyFile: vi.fn(),
		uploadFile: uploadFile as unknown as DrivePort["uploadFile"],
		downloadFile: vi.fn(),
		exportFile: vi.fn(),
		updateFile: vi.fn(),
		trashFile: vi.fn(),
		listRevisions: vi.fn(),
		getRevision: vi.fn(),
		downloadRevision: vi.fn(),
		updateRevision: vi.fn(),
		deleteRevision: vi.fn(),
	};
}

function lastUpload(): UploadDriveFileParams {
	return uploadFile.mock.calls.at(-1)?.[0] as UploadDriveFileParams;
}

function decodeBody(body: Uint8Array | string | undefined): string {
	if (typeof body === "string") return body;
	return new TextDecoder().decode(body ?? new Uint8Array());
}

async function runUpload(
	args: Record<string, unknown>,
	readLocalFile?: LocalFileReader,
): Promise<{ text: string; out: unknown }> {
	const action = createDriveUploadFileAction({
		drive: makePort(),
		readLocalFile,
	});
	const out = await executeAction(action, args, {
		context: { caller: "mcp" },
	});
	return { text: action.formatMcp!(out), out };
}

beforeEach(() => {
	vi.clearAllMocks();
	uploadFile.mockImplementation(async (params: UploadDriveFileParams) => ({
		id: "new-1",
		name: params.name,
		mimeType: params.targetMimeType ?? "text/plain",
		webViewLink: "https://docs.google.com/document/d/new-1/edit",
	}));
});

describe("drive_upload_file without convert_to (#1471)", () => {
	it("sends no targetMimeType, so Drive stores the bytes as uploaded", async () => {
		const res = await runUpload({
			name: "notes.txt",
			content: "hello",
			parent_id: "folder-1",
		});

		const call = lastUpload();
		expect(call.domain).toBe("angus");
		expect(call.name).toBe("notes.txt");
		expect(call.parents).toEqual(["folder-1"]);
		expect("targetMimeType" in call).toBe(false);
		expect(call.mimeType).toBe("text/plain");
		expect(call.fields).toBe(FILE_FIELDS);
		expect(decodeBody(call.body)).toBe("hello");
		// The reply is the pre-#1220 shape: no conversion wording, no link line.
		expect(res.text).toMatch(/^Uploaded 5 bytes:\n• \[new-1\] notes\.txt/);
		expect(res.text).not.toMatch(/Google Doc|Link:/);
	});

	it("keeps an .html name and the caller's mime type untouched", async () => {
		await runUpload({
			name: "cv.html",
			content: "<p>x</p>",
			mime_type: "text/html",
		});

		const call = lastUpload();
		expect(call.name).toBe("cv.html");
		expect(call.parents).toBeUndefined();
		expect("targetMimeType" in call).toBe(false);
		expect(call.mimeType).toBe("text/html");
	});

	it("local_path takes precedence over content and uses injected readLocalFile", async () => {
		const reader: LocalFileReader = vi.fn(async (path: string) => ({
			bytes: new TextEncoder().encode(`from-disk:${path}`),
			name: "disk.txt",
		}));

		const res = await runUpload(
			{
				name: "custom.txt",
				local_path: "/tmp/disk.txt",
				content: "ignored inline content",
				domain: "work",
			},
			reader,
		);

		expect(reader).toHaveBeenCalledWith("/tmp/disk.txt");
		const call = lastUpload();
		expect(call.domain).toBe("work");
		expect(call.name).toBe("custom.txt");
		expect(call.mimeType).toBe("application/octet-stream");
		expect(decodeBody(call.body)).toBe("from-disk:/tmp/disk.txt");
		expect(res.text).toMatch(/^Uploaded 23 bytes:\n• \[new-1\] custom\.txt/);
	});

	it("refuses when neither content nor local_path is provided, and fails loudly when local_path is passed without a reader injected", async () => {
		await expect(runUpload({ name: "empty.txt" })).rejects.toThrow(
			"Provide either `content` (inline text) or `local_path`.",
		);
		expect(uploadFile).not.toHaveBeenCalled();

		await expect(
			runUpload({
				name: "local.txt",
				local_path: "/tmp/local.txt",
				content: "must not fall back to content",
			}),
		).rejects.toThrow(/readLocalFile/);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("rejects conflicting domain and account and propagates DriveApiError status and reason", async () => {
		uploadFile.mockRejectedValueOnce(
			new DriveApiError(
				"Google Drive API error (HTTP 403): Insufficient permissions",
				403,
				"insufficientFilePermissions",
				"PERMISSION_DENIED",
			),
		);

		await expect(
			runUpload({
				name: "notes.txt",
				content: "hello",
				domain: "work",
				account: "personal",
			}),
		).rejects.toThrow(/name different domains/);

		await expect(
			runUpload({ name: "notes.txt", content: "hello" }),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 403,
			reason: "insufficientFilePermissions",
		});
	});
});

describe("drive_upload_file with convert_to 'google_doc' (#1471)", () => {
	it("converts inline HTML into a Google Doc and returns its link", async () => {
		const res = await runUpload({
			name: "Angus Hally CV.html",
			content: "<h1>CV</h1>",
			parent_id: "folder-1",
			convert_to: "google_doc",
		});

		const call = lastUpload();
		expect(call.name).toBe("Angus Hally CV");
		expect(call.parents).toEqual(["folder-1"]);
		expect(call.targetMimeType).toBe(GOOGLE_DOC_MIME_TYPE);
		// The media keeps the SOURCE type; that difference is what makes Drive convert.
		// Inline content is encoded as UTF-8, and the type says so.
		expect(call.mimeType).toBe("text/html; charset=utf-8");
		expect(decodeBody(call.body)).toBe("<h1>CV</h1>");

		expect(res.text).toContain("converted them to a Google Doc");
		expect(res.text).toContain("Link: https://docs.google.com/document/d/new-1/edit");
	});

	it("infers Markdown from the name when mime_type is omitted", async () => {
		await runUpload({ name: "cv.md", content: "# CV", convert_to: "google_doc" });

		expect(lastUpload().mimeType).toBe("text/markdown; charset=utf-8");
		expect(lastUpload().name).toBe("cv");
	});

	it("falls back to text/plain for inline content with no recognised extension", async () => {
		await runUpload({ name: "CV draft", content: "plain", convert_to: "google_doc" });

		expect(lastUpload().mimeType).toBe("text/plain; charset=utf-8");
		expect(lastUpload()).toMatchObject({
			name: "CV draft",
			targetMimeType: GOOGLE_DOC_MIME_TYPE,
		});
	});

	it.each([
		[
			"a name with no extension",
			"Angus Hally CV",
			"<!DOCTYPE html>\n<html><body><h1>CV</h1></body></html>",
		],
		[
			"a date-like name whose 'extension' is a number",
			"CV 2026.09",
			"  <h1>Angus Hally</h1><ul><li>x</li></ul>",
		],
		[
			"an HTML fragment opening with a block tag",
			"CV September 2026",
			"<section><p>x</p></section>",
		],
	])(
		"recognises inline HTML under %s, so it is not imported as literal markup",
		async (_label, name, content) => {
			await runUpload({ name, content, convert_to: "google_doc" });

			expect(lastUpload().mimeType).toBe("text/html; charset=utf-8");
			expect(lastUpload()).toMatchObject({
				name,
				targetMimeType: GOOGLE_DOC_MIME_TYPE,
			});
		},
	);

	it("does not take a Markdown or plain body for HTML", async () => {
		await runUpload({
			name: "CV",
			content: "# CV\n\n<b>inline</b> is fine",
			convert_to: "google_doc",
		});
		expect(lastUpload().mimeType).toBe("text/plain; charset=utf-8");

		await runUpload({
			name: "CV",
			content: "<placeholder> not a tag we know",
			convert_to: "google_doc",
		});
		expect(lastUpload().mimeType).toBe("text/plain; charset=utf-8");
	});

	it("lets an explicit mime_type override what the body looks like", async () => {
		await runUpload({
			name: "CV",
			content: "<h1>shown as text on purpose</h1>",
			mime_type: "text/plain",
			convert_to: "google_doc",
		});

		expect(lastUpload().mimeType).toBe("text/plain; charset=utf-8");
	});

	it("uploads non-ASCII inline content as UTF-8 bytes and declares it", async () => {
		const res = await runUpload({
			name: "Résumé.html",
			content: "<p>Résumé – £5 “quoted”</p>",
			convert_to: "google_doc",
		});

		const call = lastUpload();
		expect(call.mimeType).toBe("text/html; charset=utf-8");
		expect(decodeBody(call.body)).toBe("<p>Résumé – £5 “quoted”</p>");
		expect(res.text).toContain("(text/html; charset=utf-8)");
	});

	it("prefers an explicit mime_type, including one with parameters", async () => {
		await runUpload({
			name: "render",
			content: "<p>x</p>",
			mime_type: "text/html; charset=utf-8",
			convert_to: "google_doc",
		});

		expect(lastUpload().mimeType).toBe("text/html; charset=utf-8");
		expect(lastUpload().targetMimeType).toBe(GOOGLE_DOC_MIME_TYPE);
	});

	it("converts a local .docx, inferring the Word type from its extension", async () => {
		const reader: LocalFileReader = vi.fn(async () => ({
			bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
			name: "cv.docx",
		}));

		const res = await runUpload(
			{
				name: "cv.docx",
				local_path: "/tmp/drive-upload/cv.docx",
				convert_to: "google_doc",
			},
			reader,
		);

		const call = lastUpload();
		expect(call.mimeType).toBe(DOCX);
		expect(call).toMatchObject({
			name: "cv",
			targetMimeType: GOOGLE_DOC_MIME_TYPE,
		});
		expect(res.text).toMatch(/^Uploaded 4 bytes/);
	});

	it("does not declare a charset for a local file, whose encoding it never read", async () => {
		const reader: LocalFileReader = vi.fn(async () => ({
			bytes: new TextEncoder().encode("<h1>CV</h1>"),
			name: "cv.html",
		}));

		await runUpload(
			{
				name: "cv.html",
				local_path: "/tmp/drive-upload/cv.html",
				convert_to: "google_doc",
			},
			reader,
		);

		expect(lastUpload().mimeType).toBe("text/html");
	});

	it("does not resolve an extension through Object.prototype", async () => {
		await runUpload({
			name: "x.constructor",
			content: "plain",
			convert_to: "google_doc",
		});

		expect(lastUpload().mimeType).toBe("text/plain; charset=utf-8");
		expect(lastUpload().name).toBe("x.constructor");
	});

	it("refuses a source Drive would only OCR, before touching Drive", async () => {
		await expect(
			runUpload({
				name: "scan",
				content: "x",
				mime_type: "application/pdf",
				convert_to: "google_doc",
			}),
		).rejects.toThrow(
			/HTML, Markdown, plain-text or \.docx source.*"application\/pdf".*Nothing was uploaded/,
		);

		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("refuses a local file with no recognised extension and no mime_type, before reading it", async () => {
		const reader: LocalFileReader = vi.fn();
		await expect(
			runUpload(
				{
					name: "blob",
					local_path: "/tmp/does-not-exist-and-has-no-extension",
					convert_to: "google_doc",
				},
				reader,
			),
		).rejects.toThrow(/no recognised extension, and no mime_type/);

		expect(reader).not.toHaveBeenCalled();
		expect(uploadFile).not.toHaveBeenCalled();
	});
});

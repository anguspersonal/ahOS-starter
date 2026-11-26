import { describe, expect, it, vi } from "vitest";
import type { DriveApiError } from "../../../ports/drive.js";
import {
	COMMENT_FIELDS, COMMENT_LIST_FIELDS, createGoogleDriveAdapter, FILE_FIELDS, formatFile, formatList, isFolder,
	isGoogleDoc, LIST_FIELDS, PERMISSION_CREATE_FIELDS, PERMISSION_FIELDS, REPLY_LIST_FIELDS, REVISION_FIELDS, REVISION_LIST_FIELDS,
} from "./index.js";

function makeAdapter(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
	return createGoogleDriveAdapter({
		clientId: "cid", clientSecret: "csecret",
		refreshToken: async (d) => (d === "work" ? "rt-work" : "rt-angus"),
		fetchFn: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				const token = String(init?.body ?? "").includes("rt-work") ? "at-work" : "at-angus";
				return new Response(JSON.stringify({ access_token: token }), { status: 200 });
			}
			return handler(url, init);
		}),
	});
}

describe("createGoogleDriveAdapter (#1586)", () => {
	it("getFile sends supportsAllDrives=true, default FILE_FIELDS mask, and distinct domain tokens", async () => {
		const calls: Array<{ url: URL; auth: string | null }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
			return new Response(JSON.stringify({ id: "file-1", name: "Spec", mimeType: "text/plain" }), { status: 200 });
		});
		const file = await adapter.getFile({ domain: "work", fileId: "file-1" });
		await adapter.getFile({ domain: "angus", fileId: "file-2", fields: "id, name" });

		expect(file).toEqual({ id: "file-1", name: "Spec", mimeType: "text/plain" });
		expect([calls[0].url.pathname, calls[0].url.searchParams.get("supportsAllDrives"), calls[0].url.searchParams.get("fields")]).toEqual([
			"/drive/v3/files/file-1", "true", FILE_FIELDS,
		]);
		expect([calls[0].auth, calls[1].auth, calls[1].url.searchParams.get("fields")]).toEqual(["Bearer at-work", "Bearer at-angus", "id, name"]);
	});

	it("listFiles sends supportsAllDrives, includeItemsFromAllDrives, q, pageSize, pageToken, orderBy, and fields", async () => {
		let u: URL | undefined;
		const res = await makeAdapter((url) => {
			u = url;
			return new Response(JSON.stringify({ files: [{ id: "f1", name: "A" }], nextPageToken: "tok-2", incompleteSearch: true }), { status: 200 });
		}).listFiles({ domain: "angus", q: "trashed = false", pageSize: 25, pageToken: "tok-1", orderBy: "modifiedTime desc" });

		expect(res).toEqual({ files: [{ id: "f1", name: "A" }], nextPageToken: "tok-2", incompleteSearch: true });
		expect([
			u?.pathname, u?.searchParams.get("supportsAllDrives"), u?.searchParams.get("includeItemsFromAllDrives"),
			u?.searchParams.get("q"), u?.searchParams.get("pageSize"), u?.searchParams.get("pageToken"),
			u?.searchParams.get("orderBy"), u?.searchParams.get("fields"),
		]).toEqual(["/drive/v3/files", "true", "true", "trashed = false", "25", "tok-1", "modifiedTime desc", LIST_FIELDS]);
	});

	it("listPermissions sends supportsAllDrives=true and default PERMISSION_FIELDS mask", async () => {
		let u: URL | undefined;
		const perms = await makeAdapter((url) => {
			u = url;
			return new Response(JSON.stringify({ permissions: [{ id: "p1", type: "user", role: "writer", emailAddress: "a@example.com" }] }), { status: 200 });
		}).listPermissions({ domain: "work", fileId: "f1" });
		expect(perms).toEqual([{ id: "p1", type: "user", role: "writer", emailAddress: "a@example.com" }]);
		expect([u?.pathname, u?.searchParams.get("supportsAllDrives"), u?.searchParams.get("fields")]).toEqual([
			"/drive/v3/files/f1/permissions", "true", PERMISSION_FIELDS,
		]);
	});

	it("throws DriveApiError with numeric status and Google reason on non-2xx responses", async () => {
		const adapter = makeAdapter(() => new Response(JSON.stringify({
			error: { code: 404, message: "File not found: missing-id.", status: "NOT_FOUND", errors: [{ reason: "notFound" }] },
		}), { status: 404 }));
		await expect(adapter.getFile({ domain: "angus", fileId: "missing-id" })).rejects.toMatchObject({
			name: "DriveApiError", status: 404, reason: "notFound", googleStatus: "NOT_FOUND",
		} satisfies Partial<DriveApiError>);
	});

	it("formats files and classifies mime types identically to legacy helpers", () => {
		expect([isGoogleDoc("application/vnd.google-apps.document"), isFolder("application/vnd.google-apps.folder"), formatList([])]).toEqual([true, true, "No files."]);
		expect(formatFile({
			id: "1", name: "Doc", mimeType: "text/plain", size: "42",
			modifiedTime: "2026-01-01T00:00:00Z", trashed: true, owners: [{ emailAddress: "x@example.com" }],
		})).toBe("• [1] Doc (text/plain, 42 bytes, modified 2026-01-01T00:00:00Z, TRASHED, owner x@example.com)");
	});

	it("uploadFile sends multipart/related POST with supportsAllDrives=true, parents metadata, and binary bytes", async () => {
		let capturedUrl: URL | undefined;
		let capturedInit: RequestInit | undefined;
		const binaryPdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0x00]);

		const adapter = makeAdapter((url, init) => {
			capturedUrl = url;
			capturedInit = init;
			return new Response(
				JSON.stringify({
					id: "uploaded-1",
					name: "invoice.pdf",
					mimeType: "application/pdf",
					size: String(binaryPdf.byteLength),
					webViewLink: "https://drive.google.com/file/d/uploaded-1/view",
					parents: ["folder-99"],
				}),
				{ status: 200 },
			);
		});

		const uploaded = await adapter.uploadFile({
			domain: "work",
			name: "invoice.pdf",
			folderId: "folder-99",
			mimeType: "application/pdf",
			data: binaryPdf,
		});

		expect(uploaded.id).toBe("uploaded-1");
		expect(capturedUrl?.pathname).toBe("/upload/drive/v3/files");
		expect(capturedUrl?.searchParams.get("uploadType")).toBe("multipart");
		expect(capturedUrl?.searchParams.get("supportsAllDrives")).toBe("true");
		expect(capturedUrl?.searchParams.get("fields")).toBe(FILE_FIELDS);
		expect(capturedInit?.method).toBe("POST");
		const headers = new Headers(capturedInit?.headers);
		expect(headers.get("Authorization")).toBe("Bearer at-work");
		expect(headers.get("Content-Type")).toMatch(/^multipart\/related; boundary=/);

		const sentBody = capturedInit?.body as Uint8Array;
		expect(sentBody).toBeInstanceOf(Uint8Array);
		const bodyText = new TextDecoder("latin1").decode(sentBody);
		expect(bodyText).toContain(JSON.stringify({ name: "invoice.pdf", mimeType: "application/pdf", parents: ["folder-99"] }));
		const pdfLatin1 = new TextDecoder("latin1").decode(binaryPdf);
		expect(bodyText.includes(pdfLatin1)).toBe(true);

		await adapter.uploadFile({
			domain: "angus",
			name: "notes.txt",
			parents: ["folder-1"],
			mimeType: "text/plain",
			body: "hello",
		});
		const plainText = new TextDecoder().decode(capturedInit?.body as Uint8Array);
		expect(plainText).toContain(JSON.stringify({ name: "notes.txt", parents: ["folder-1"] }));
		expect(plainText).toContain("Content-Type: text/plain\r\n\r\nhello");

		await adapter.uploadFile("work", {
			name: "Spec",
			targetMimeType: "application/vnd.google-apps.document",
			mimeType: "text/markdown; charset=utf-8",
			body: "# Spec",
		});
		const convertedText = new TextDecoder().decode(capturedInit?.body as Uint8Array);
		expect(convertedText).toContain(
			JSON.stringify({ name: "Spec", mimeType: "application/vnd.google-apps.document" }),
		);
		expect(convertedText).toContain("Content-Type: text/markdown; charset=utf-8\r\n\r\n# Spec");
	});

	it("FILE_FIELDS and LIST_FIELDS include md5Checksum and sha256Checksum (#2045)", () => {
		expect(FILE_FIELDS).toContain("md5Checksum");
		expect(FILE_FIELDS).toContain("sha256Checksum");
		expect(LIST_FIELDS).toContain("md5Checksum");
		expect(LIST_FIELDS).toContain("sha256Checksum");
	});

	it("downloadFile requests alt=media&supportsAllDrives=true, returns Uint8Array, and enforces maxBytes (#2045)", async () => {
		let capturedUrl: URL | undefined;
		let capturedAuth: string | null = null;
		const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

		const adapter = makeAdapter((url, init) => {
			capturedUrl = url;
			capturedAuth = new Headers(init?.headers).get("Authorization");
			return new Response(payload, {
				status: 200,
				headers: { "Content-Length": String(payload.byteLength) },
			});
		});

		const bytes = await adapter.downloadFile({
			domain: "angus",
			fileId: "file-bin-1",
			maxBytes: 10,
		});

		expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
		expect(capturedUrl?.pathname).toBe("/drive/v3/files/file-bin-1");
		expect(capturedUrl?.searchParams.get("alt")).toBe("media");
		expect(capturedUrl?.searchParams.get("supportsAllDrives")).toBe("true");
		expect(capturedAuth).toBe("Bearer at-angus");

		await expect(
			adapter.downloadFile({
				domain: "angus",
				fileId: "file-bin-1",
				maxBytes: 2,
			}),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 413,
		});
	});

	it("exportFile and countDocumentTabs request /export and Docs tabs with fields mask (#2045, #1592)", async () => {
		const calls: URL[] = [];
		const exportedDocx = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

		const adapter = makeAdapter((url) => {
			calls.push(url);
			if (url.hostname === "docs.googleapis.com") {
				return new Response(
					JSON.stringify({
						tabs: [{ tabProperties: { tabId: "t1" } }, { tabProperties: { tabId: "t2" } }],
					}),
					{ status: 200 },
				);
			}
			return new Response(exportedDocx, { status: 200 });
		});

		const bytes = await adapter.exportFile({
			domain: "work",
			fileId: "gdoc-1",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});
		const tabs = await adapter.countDocumentTabs!({ domain: "work", fileId: "gdoc-1" });

		expect(Array.from(bytes)).toEqual([0x50, 0x4b, 0x03, 0x04]);
		expect(tabs).toBe(2);
		expect(calls[0]?.pathname).toBe("/drive/v3/files/gdoc-1/export");
		expect(calls[0]?.searchParams.get("mimeType")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(calls[1]?.hostname).toBe("docs.googleapis.com");
		expect(calls[1]?.searchParams.get("includeTabsContent")).toBe("true");
		expect(calls[1]?.searchParams.get("fields")).toBe(
			"tabs(tabProperties(tabId),childTabs(tabProperties(tabId),childTabs(tabProperties(tabId))))",
		);
	});

	it("trashFile sends PATCH with trashed=true and supportsAllDrives=true (#2045)", async () => {
		let capturedUrl: URL | undefined;
		let capturedInit: RequestInit | undefined;

		const adapter = makeAdapter((url, init) => {
			capturedUrl = url;
			capturedInit = init;
			return new Response(
				JSON.stringify({ id: "corrupt-1", name: "corrupt.bin", trashed: true }),
				{ status: 200 },
			);
		});

		const trashed = await adapter.trashFile({
			domain: "angus",
			fileId: "corrupt-1",
		});

		expect(trashed).toEqual({ id: "corrupt-1", name: "corrupt.bin", trashed: true });
		expect(capturedUrl?.pathname).toBe("/drive/v3/files/corrupt-1");
		expect(capturedUrl?.searchParams.get("supportsAllDrives")).toBe("true");
		expect(capturedInit?.method).toBe("PATCH");
		expect(capturedInit?.body).toBe(JSON.stringify({ trashed: true }));
	});

	it("supports revision list, get, download (media and exportUrl), update, and delete (#1647)", async () => {
		const calls: Array<{ url: URL; method: string; body?: string }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
			if (url.pathname.endsWith("/revisions")) {
				return new Response(JSON.stringify({ revisions: [{ id: "r1", keepForever: false }], nextPageToken: "next-r" }), { status: 200 });
			}
			if (url.searchParams.get("alt") === "media" || url.hostname === "docs.google.com") {
				return new Response(new Uint8Array([0x68, 0x69]), { status: 200 });
			}
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			return new Response(JSON.stringify({ id: "r1", keepForever: init?.method === "PATCH" }), { status: 200 });
		});

		const list = await adapter.listRevisions({ domain: "work", fileId: "f1", pageSize: 10, pageToken: "p1" });
		const rev = await adapter.getRevision({ domain: "work", fileId: "f1", revisionId: "r1" });
		const media = await adapter.downloadRevision({ domain: "work", fileId: "f1", revisionId: "r1" });
		const exported = await adapter.downloadRevision({
			domain: "work", fileId: "f1", revisionId: "r1", exportUrl: "https://docs.google.com/feeds/download/documents/export/Export?id=f1&revision=r1&exportFormat=txt",
		});
		const updated = await adapter.updateRevision({ domain: "work", fileId: "f1", revisionId: "r1", keepForever: true });
		await adapter.deleteRevision({ domain: "work", fileId: "f1", revisionId: "r1" });

		expect(list).toEqual({ revisions: [{ id: "r1", keepForever: false }], nextPageToken: "next-r" });
		expect([calls[0].url.pathname, calls[0].url.searchParams.get("fields")]).toEqual(["/drive/v3/files/f1/revisions", REVISION_LIST_FIELDS]);
		expect([rev.id, calls[1].url.pathname, calls[1].url.searchParams.get("fields")]).toEqual(["r1", "/drive/v3/files/f1/revisions/r1", REVISION_FIELDS]);
		expect([new TextDecoder().decode(media), new TextDecoder().decode(exported)]).toEqual(["hi", "hi"]);
		expect([updated.keepForever, calls[4].method, calls[4].body]).toEqual([true, "PATCH", JSON.stringify({ keepForever: true })]);
		expect([calls[5].method, calls[5].url.pathname]).toEqual(["DELETE", "/drive/v3/files/f1/revisions/r1"]);
	});

	it("updateFile sends PATCH with supportsAllDrives=true, FILE_FIELDS mask, addParents/removeParents query params, and JSON body (#1481)", async () => {
		const calls: Array<{ url: URL; method: string; body: string }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ id: "file-9", name: "Renamed.pdf", trashed: false }), { status: 200 });
		});

		const renamed = await adapter.updateFile("work", "file-9", {
			name: "Renamed.pdf",
			addParents: "parent-new",
			removeParents: "parent-old",
		});
		const trashed = await adapter.updateFile({ domain: "angus", fileId: "file-9", trashed: true });

		expect(renamed).toEqual({ id: "file-9", name: "Renamed.pdf", trashed: false });
		expect(trashed).toEqual({ id: "file-9", name: "Renamed.pdf", trashed: false });
		expect([
			calls[0].method, calls[0].url.pathname, calls[0].url.searchParams.get("supportsAllDrives"),
			calls[0].url.searchParams.get("fields"), calls[0].url.searchParams.get("addParents"),
			calls[0].url.searchParams.get("removeParents"), calls[0].body,
		]).toEqual(["PATCH", "/drive/v3/files/file-9", "true", FILE_FIELDS, "parent-new", "parent-old", JSON.stringify({ name: "Renamed.pdf" })]);
		expect([
			calls[1].method, calls[1].url.searchParams.get("supportsAllDrives"),
			calls[1].url.searchParams.get("fields"), calls[1].body,
		]).toEqual(["PATCH", "true", FILE_FIELDS, JSON.stringify({ trashed: true })]);
	});

	it("createFile supports metadata-only JSON POST and byte-exact Uint8Array multipart/related upload, and copyFile POSTs to /copy (#1591)", async () => {
		const calls: Array<{ url: URL; method: string; contentType: string | null; body: unknown }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({
				url,
				method: init?.method ?? "GET",
				contentType: new Headers(init?.headers).get("Content-Type"),
				body: init?.body,
			});
			return new Response(JSON.stringify({ id: "created-1", name: "Folder", mimeType: "application/vnd.google-apps.folder" }), { status: 200 });
		});

		await adapter.createFile({
			domain: "angus",
			name: "Root Folder",
			mimeType: "application/vnd.google-apps.folder",
		});
		const mediaBytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff]);
		await adapter.createFile("work", {
			name: "blob.bin",
			parents: ["folder-1"],
			boundary: "test_boundary",
			media: { mimeType: "application/octet-stream", body: mediaBytes },
		});
		await adapter.copyFile({ domain: "work", fileId: "src-1", name: "Copy of Doc", parents: ["dest-1"] });
		await adapter.copyFile("angus", "src-2");

		expect([
			calls[0].method, calls[0].url.pathname, calls[0].url.searchParams.get("supportsAllDrives"),
			calls[0].url.searchParams.get("fields"), calls[0].contentType, calls[0].body,
		]).toEqual([
			"POST", "/drive/v3/files", "true", FILE_FIELDS, "application/json",
			JSON.stringify({ name: "Root Folder", mimeType: "application/vnd.google-apps.folder" }),
		]);

		const expectedPreamble = new TextEncoder().encode(
			`--test_boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: "blob.bin", parents: ["folder-1"] })}\r\n--test_boundary\r\nContent-Type: application/octet-stream\r\n\r\n`,
		);
		const expectedEpilogue = new TextEncoder().encode("\r\n--test_boundary--");
		const expectedMultipart = new Uint8Array(expectedPreamble.byteLength + mediaBytes.byteLength + expectedEpilogue.byteLength);
		expectedMultipart.set(expectedPreamble, 0);
		expectedMultipart.set(mediaBytes, expectedPreamble.byteLength);
		expectedMultipart.set(expectedEpilogue, expectedPreamble.byteLength + mediaBytes.byteLength);

		expect([
			calls[1].method, calls[1].url.pathname, calls[1].url.searchParams.get("uploadType"),
			calls[1].url.searchParams.get("supportsAllDrives"), calls[1].url.searchParams.get("fields"),
			calls[1].contentType, calls[1].body instanceof Uint8Array,
		]).toEqual([
			"POST", "/upload/drive/v3/files", "multipart", "true", FILE_FIELDS,
			"multipart/related; boundary=test_boundary", true,
		]);
		expect(Array.from(calls[1].body as Uint8Array)).toEqual(Array.from(expectedMultipart));

		expect([
			calls[2].method, calls[2].url.pathname, calls[2].url.searchParams.get("supportsAllDrives"),
			calls[2].url.searchParams.get("fields"), calls[2].body,
		]).toEqual([
			"POST", "/drive/v3/files/src-1/copy", "true", FILE_FIELDS,
			JSON.stringify({ name: "Copy of Doc", parents: ["dest-1"] }),
		]);
		expect([
			calls[3].method, calls[3].url.pathname, calls[3].url.searchParams.get("supportsAllDrives"),
			calls[3].url.searchParams.get("fields"), calls[3].body,
		]).toEqual(["POST", "/drive/v3/files/src-2/copy", "true", FILE_FIELDS, "{}"]);
	});

	it("downloadFile(domain, fileId, mimeType) reads all tabs of a Google Doc via Docs API and all sheets of a Google Spreadsheet via Sheets API without calling Drive export (#1590)", async () => {
		const calls: URL[] = [];
		const adapter = makeAdapter((url) => {
			calls.push(url);
			if (url.hostname === "docs.googleapis.com") {
				return new Response(
					JSON.stringify({
						documentId: "doc-tabs-1",
						title: "Meeting Notes",
						tabs: [
							{
								tabProperties: { tabId: "t1", title: "Summary" },
								documentTab: {
									body: {
										content: [
											{ paragraph: { elements: [{ textRun: { content: "First tab body\n" } }] } },
										],
									},
								},
							},
							{
								tabProperties: { tabId: "t2", title: "Transcript" },
								documentTab: {
									body: {
										content: [
											{ paragraph: { elements: [{ textRun: { content: "Second tab body\n" } }] } },
										],
									},
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (url.hostname === "sheets.googleapis.com" && url.pathname.endsWith("/values:batchGet")) {
				return new Response(
					JSON.stringify({
						spreadsheetId: "sheet-2",
						valueRanges: [
							{ range: "'Q1 Summary'!A1:B2", values: [["Metric", "Value"], ["ARR", "100,000"]] },
							{ range: "'Raw Data'!A1:B1", values: [["ID", "Notes"]] },
						],
					}),
					{ status: 200 },
				);
			}
			if (url.hostname === "sheets.googleapis.com") {
				return new Response(
					JSON.stringify({
						spreadsheetId: "sheet-2",
						properties: { title: "Financials" },
						sheets: [
							{ properties: { sheetId: 0, title: "Q1 Summary", index: 0, hidden: false, sheetType: "GRID" } },
							{ properties: { sheetId: 1, title: "Raw Data", index: 1, hidden: true, sheetType: "GRID" } },
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected URL: ${url.toString()}`);
		});

		const docResult = await adapter.downloadFile(
			"angus",
			"doc-tabs-1",
			"application/vnd.google-apps.document",
		);
		expect(docResult.mimeType).toBe("text/markdown");
		expect(docResult.extension).toBe("md");
		const docText = new TextDecoder().decode(docResult.bytes);
		expect(docText).toContain("## Summary\n\nFirst tab body");
		expect(docText).toContain("## Transcript\n\nSecond tab body");

		const sheetResult = await adapter.downloadFile(
			"work",
			"sheet-2",
			"application/vnd.google-apps.spreadsheet",
		);
		expect(sheetResult.mimeType).toBe("text/markdown");
		expect(sheetResult.extension).toBe("md");
		const sheetText = new TextDecoder().decode(sheetResult.bytes);
		expect(sheetText).toContain("## Q1 Summary\n\n```csv\nMetric,Value\nARR,\"100,000\"\n```");
		expect(sheetText).toContain("## Raw Data (hidden)\n\n```csv\nID,Notes\n```");

		// Verify Docs includeTabsContent, Sheets fields masks, and absence of Drive /export calls
		expect(calls.some((u) => u.pathname.endsWith("/export"))).toBe(false);
		expect(calls[0].hostname).toBe("docs.googleapis.com");
		expect(calls[0].searchParams.get("includeTabsContent")).toBe("true");
		expect(calls[1].hostname).toBe("sheets.googleapis.com");
		expect(calls[1].searchParams.get("fields")).toContain("sheets.properties");
		expect(calls[2].pathname).toBe("/v4/spreadsheets/sheet-2/values:batchGet");
		expect(calls[2].searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE");
		expect(calls[2].searchParams.getAll("ranges")).toEqual(["'Q1 Summary'", "'Raw Data'"]);
	});

	it("downloadFile(domain, fileId, mimeType) exports Slides via /export, downloads raw media via alt=media, and rejects folders and unexportable types (#1590)", async () => {
		const calls: URL[] = [];
		const adapter = makeAdapter((url) => {
			calls.push(url);
			if (url.pathname.endsWith("/export")) {
				return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 });
			}
			return new Response(new TextEncoder().encode("plain body"), { status: 200 });
		});

		const slides = await adapter.downloadFile(
			"angus",
			"deck-1",
			"application/vnd.google-apps.presentation",
		);
		expect(slides.mimeType).toBe("application/pdf");
		expect(slides.extension).toBe("pdf");
		expect(Array.from(slides.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
		expect(calls[0].pathname).toBe("/drive/v3/files/deck-1/export");
		expect(calls[0].searchParams.get("mimeType")).toBe("application/pdf");

		const media = await adapter.downloadFile("angus", "txt-1", "text/plain");
		expect(media.mimeType).toBe("text/plain");
		expect(media.extension).toBeNull();
		expect(new TextDecoder().decode(media.bytes)).toBe("plain body");
		expect(calls[1].pathname).toBe("/drive/v3/files/txt-1");
		expect(calls[1].searchParams.get("alt")).toBe("media");

		await expect(
			adapter.downloadFile("angus", "folder-1", "application/vnd.google-apps.folder"),
		).rejects.toThrow("File folder-1 is a folder and has no content to download.");

		await expect(
			adapter.downloadFile("angus", "form-1", "application/vnd.google-apps.form"),
		).rejects.toThrow('Google-native file type "application/vnd.google-apps.form" cannot be exported by these tools.');
	});

	it("deleteFile and deletePermission send DELETE with supportsAllDrives=true and surface DriveApiError (#1496)", async () => {
		const calls: Array<{ method: string; url: URL }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ method: String(init?.method ?? "GET"), url });
			if (url.pathname.includes("missing")) {
				return new Response(
					JSON.stringify({ error: { code: 404, message: "File not found", reason: "notFound" } }),
					{ status: 404 },
				);
			}
			return new Response(null, { status: 204 });
		});

		await adapter.deleteFile!("angus", "file-del-1");
		await adapter.deletePermission!("work", "file-del-1", "perm-99");

		expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get("supportsAllDrives")])).toEqual([
			["DELETE", "/drive/v3/files/file-del-1", "true"],
			["DELETE", "/drive/v3/files/file-del-1/permissions/perm-99", "true"],
		]);

		await expect(adapter.deleteFile!({ domain: "angus", fileId: "missing" })).rejects.toMatchObject({
			name: "DriveApiError",
			status: 404,
			reason: "notFound",
		});
	});

	it("supports listComments, createComment, and createReply (#1530)", async () => {
		const calls: Array<{ url: URL; method: string; body?: string }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
			if (url.pathname.endsWith("/comments") && (init?.method ?? "GET") === "GET") {
				return new Response(JSON.stringify({ comments: [{ id: "c-1", content: "Hi" }], nextPageToken: "next-c" }), { status: 200 });
			}
			if (url.pathname.endsWith("/comments")) {
				return new Response(JSON.stringify({ id: "c-2", content: "New comment" }), { status: 200 });
			}
			return new Response(JSON.stringify({ id: "r-1", content: "New reply" }), { status: 200 });
		});

		const list = await adapter.listComments!({ domain: "work", fileId: "doc-1", pageSize: 20 });
		const created = await adapter.createComment!({
			domain: "angus",
			fileId: "doc-1",
			content: "New comment",
			quotedFileContent: { value: "quote", mimeType: "text/plain" },
		});
		const replied = await adapter.createReply!({
			domain: "angus",
			fileId: "doc-1",
			commentId: "c-2",
			content: "New reply",
		});

		expect(list).toEqual({ comments: [{ id: "c-1", content: "Hi" }], nextPageToken: "next-c" });
		expect([calls[0].url.pathname, calls[0].url.searchParams.get("pageSize"), calls[0].url.searchParams.get("includeDeleted")]).toEqual([
			"/drive/v3/files/doc-1/comments", "20", "false",
		]);
		expect([created.id, calls[1].method, calls[1].url.pathname, calls[1].body]).toEqual([
			"c-2", "POST", "/drive/v3/files/doc-1/comments",
			JSON.stringify({ content: "New comment", quotedFileContent: { value: "quote", mimeType: "text/plain" } }),
		]);
		expect([replied.id, calls[2].method, calls[2].url.pathname, calls[2].body]).toEqual([
			"r-1", "POST", "/drive/v3/files/doc-1/comments/c-2/replies",
			JSON.stringify({ content: "New reply" }),
		]);
	});

	it("supports getComment, listReplies, 429/5xx single retry with backoff, and token redaction (#1645)", async () => {
		const calls: URL[] = [];
		const sleeps: number[] = [];
		let attempts = 0;
		const adapter = createGoogleDriveAdapter({
			clientId: "cid", clientSecret: "csecret",
			refreshToken: async () => "rt-work",
			sleepFn: async (ms) => { sleeps.push(ms); },
			fetchFn: vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "secret-at-99" }), { status: 200 });
				}
				calls.push(url);
				attempts += 1;
				if (attempts === 1) return new Response("rate limited", { status: 429 });
				if (url.pathname.endsWith("/replies")) {
					return new Response(JSON.stringify({ replies: [{ id: "rep-1", content: "ok" }], nextPageToken: "rp-2" }), { status: 200 });
				}
				if (url.pathname.includes("leak")) {
					return new Response(JSON.stringify({ error: { message: "bad Bearer secret-at-99 and secret-at-99" } }), { status: 500 });
				}
				return new Response(JSON.stringify({ id: "c-9", content: "Thread root" }), { status: 200 });
			}),
		});

		const comment = await adapter.getComment!({ domain: "work", fileId: "f-1", commentId: "c-9" });
		const replies = await adapter.listReplies!({ domain: "work", fileId: "f-1", commentId: "c-9", pageSize: 100, pageToken: "rp-1" });

		expect(comment).toEqual({ id: "c-9", content: "Thread root" });
		expect(replies).toEqual({ replies: [{ id: "rep-1", content: "ok" }], nextPageToken: "rp-2" });
		expect(sleeps).toEqual([250]);
		expect(COMMENT_LIST_FIELDS).toContain("nextPageToken");
		expect([calls[1].pathname, calls[1].searchParams.get("includeDeleted"), calls[1].searchParams.get("fields")]).toEqual([
			"/drive/v3/files/f-1/comments/c-9", "false", COMMENT_FIELDS,
		]);
		expect([calls[2].pathname, calls[2].searchParams.get("pageSize"), calls[2].searchParams.get("pageToken"), calls[2].searchParams.get("fields")]).toEqual([
			"/drive/v3/files/f-1/comments/c-9/replies", "100", "rp-1", REPLY_LIST_FIELDS,
		]);

		await expect(adapter.getComment!({ domain: "work", fileId: "leak", commentId: "c-1" })).rejects.toSatisfy((e: unknown) => {
			const err = e as DriveApiError;
			return err.status === 500 && !err.message.includes("secret-at-99");
		});
		expect(sleeps).toEqual([250, 250, 500]);
	});

	it("createPermission sends supportsAllDrives=true, PERMISSION_CREATE_FIELDS, sendNotificationEmail, transferOwnership on owner, and DriveApiError on failure (#1505)", async () => {
		const calls: Array<{ url: URL; method: string; body: string }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
			if (url.pathname.includes("forbidden")) {
				return new Response(
					JSON.stringify({ error: { code: 403, message: "Cannot share", errors: [{ reason: "sharingRateLimitExceeded" }] } }),
					{ status: 403 },
				);
			}
			const parsed = JSON.parse(String(init?.body ?? "{}"));
			return new Response(
				JSON.stringify({ id: "p-99", role: parsed.role, type: parsed.type, emailAddress: parsed.emailAddress, domain: parsed.domain }),
				{ status: 200 },
			);
		});

		const p1 = await adapter.createPermission!({
			domain: "work",
			fileId: "f-1",
			role: "writer",
			type: "domain",
			granteeDomain: "example.com",
			sendNotificationEmail: false,
		});
		const p2 = await adapter.createPermission!({
			domain: "angus",
			fileId: "f-2",
			role: "owner",
			type: "user",
			emailAddress: "owner@example.com",
			sendNotificationEmail: true,
		});

		expect(p1).toEqual({ id: "p-99", role: "writer", type: "domain", domain: "example.com" });
		expect([
			calls[0].method,
			calls[0].url.pathname,
			calls[0].url.searchParams.get("supportsAllDrives"),
			calls[0].url.searchParams.get("fields"),
			calls[0].url.searchParams.get("sendNotificationEmail"),
			calls[0].url.searchParams.get("transferOwnership"),
			calls[0].body,
		]).toEqual([
			"POST",
			"/drive/v3/files/f-1/permissions",
			"true",
			PERMISSION_CREATE_FIELDS,
			"false",
			null,
			JSON.stringify({ role: "writer", type: "domain", domain: "example.com" }),
		]);

		expect(p2).toEqual({ id: "p-99", role: "owner", type: "user", emailAddress: "owner@example.com" });
		expect([
			calls[1].url.searchParams.get("transferOwnership"),
			calls[1].url.searchParams.get("sendNotificationEmail"),
			calls[1].url.searchParams.get("fields"),
			calls[1].body,
		]).toEqual([
			"true",
			"true",
			PERMISSION_CREATE_FIELDS,
			JSON.stringify({ role: "owner", type: "user", emailAddress: "owner@example.com" }),
		]);

		await expect(
			adapter.createPermission!({ domain: "angus", fileId: "forbidden", role: "reader", type: "anyone" }),
		).rejects.toMatchObject({
			name: "DriveApiError",
			status: 403,
			reason: "sharingRateLimitExceeded",
		});
	});

	it("supports updateComment, deleteComment, and action-only createReply (#1646)", async () => {
		const calls: Array<{ url: URL; method: string; body?: string }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
			if ((init?.method ?? "GET") === "PATCH") {
				return new Response(JSON.stringify({ id: "c-2", content: "Edited", resolved: false }), { status: 200 });
			}
			if ((init?.method ?? "GET") === "DELETE") {
				return new Response(null, { status: 204 });
			}
			return new Response(JSON.stringify({ id: "r-2", action: "resolve" }), { status: 200 });
		});

		const updated = await adapter.updateComment!({
			domain: "work", fileId: "doc-1", commentId: "c-2", content: "Edited",
		});
		await adapter.deleteComment!({ domain: "work", fileId: "doc-1", commentId: "c-2" });
		const resolvedReply = await adapter.createReply!({
			domain: "angus", fileId: "doc-1", commentId: "c-2", action: "resolve",
		});

		expect([updated.id, calls[0].method, calls[0].url.pathname, calls[0].body]).toEqual([
			"c-2", "PATCH", "/drive/v3/files/doc-1/comments/c-2", JSON.stringify({ content: "Edited" }),
		]);
		expect([calls[1].method, calls[1].url.pathname]).toEqual(["DELETE", "/drive/v3/files/doc-1/comments/c-2"]);
		expect([resolvedReply.id, calls[2].method, calls[2].url.pathname, calls[2].body]).toEqual([
			"r-2", "POST", "/drive/v3/files/doc-1/comments/c-2/replies", JSON.stringify({ action: "resolve" }),
		]);
	});
});

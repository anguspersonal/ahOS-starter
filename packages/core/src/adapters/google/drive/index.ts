import type { Domain } from "../../../domain/domains.js";
import {
	COMMENT_CREATE_FIELDS,
	COMMENT_FIELDS,
	COMMENT_LIST_FIELDS,
	DRIVE_MULTIPART_BOUNDARY,
	DriveApiError,
	FOLDER_MIME_TYPE,
	GOOGLE_EXPORT,
	isFolder,
	isGoogleDoc,
	PERMISSION_CREATE_FIELDS,
	REPLY_CREATE_FIELDS,
	REPLY_FIELDS,
	REPLY_LIST_FIELDS,
	REVISION_FIELDS,
	REVISION_LIST_FIELDS,
	type CopyDriveFileOptions,
	type CopyDriveFileParams,
	type CountDocumentTabsParams,
	type CreateDriveCommentParams,
	type CreateDriveFileMetadata,
	type CreateDriveFileParams,
	type CreateDrivePermissionParams,
	type CreateDriveReplyParams,
	type DeleteDriveCommentParams,
	type DeleteDriveFileParams,
	type DeleteDrivePermissionParams,
	type DeleteDriveRevisionParams,
	type DownloadedDriveFile,
	type DownloadDriveFileParams,
	type DownloadDriveFileWithMimeParams,
	type DownloadDriveRevisionParams,
	type DriveAbout,
	type DriveComment,
	type DriveCommentList,
	type DriveCommentReply,
	type DriveFile,
	type DriveFileList,
	type DriveFileMedia,
	type DrivePermission,
	type DrivePermissionList,
	type DrivePermissionRole,
	type DrivePermissionType,
	type DrivePort,
	type DriveReplyList,
	type DriveRevision,
	type DriveRevisionList,
	type ExportDriveFileParams,
	type GetDriveAboutParams,
	type GetDriveCommentParams,
	type GetDriveFileParams,
	type GetDriveRevisionParams,
	type ListDriveCommentsParams,
	type ListDriveFilesParams,
	type ListDrivePermissionsParams,
	type ListDriveRepliesParams,
	type ListDriveRevisionsParams,
	type LocalFileReader,
	type LocalFileReadResult,
	type TrashDriveFileParams,
	type UpdateDriveCommentParams,
	type UpdateDriveFileContentParams,
	type UpdateDriveFileParams,
	type UpdateDriveFilePatch,
	type UpdateDriveRevisionParams,
	type UploadDriveFileOptions,
	type UploadDriveFileParams,
} from "../../../ports/drive.js";
import {
	batchGetValues,
	getSpreadsheetMetadata,
	quoteSheetTitle,
	type SheetTab,
} from "../../sheets/client.js";
import { countDocumentTabs as countDocsTabs, readDocument } from "../docs/reader.js";
import { createGoogleTokenSource, type GoogleTokenSourceConfig } from "../tokenSource.js";
import { ABOUT_FIELDS, FILE_FIELDS, LIST_FIELDS, PERMISSION_FIELDS } from "./format.js";

export * from "./format.js";
export {
	COMMENT_CREATE_FIELDS,
	COMMENT_FIELDS,
	COMMENT_LIST_FIELDS,
	DRIVE_MULTIPART_BOUNDARY,
	FOLDER_MIME_TYPE,
	PERMISSION_CREATE_FIELDS,
	REPLY_CREATE_FIELDS,
	REPLY_FIELDS,
	REPLY_LIST_FIELDS,
	REVISION_FIELDS,
	REVISION_LIST_FIELDS,
	type CopyDriveFileOptions,
	type CopyDriveFileParams,
	type CreateDriveCommentParams,
	type CreateDriveFileMetadata,
	type CreateDriveFileParams,
	type CreateDrivePermissionParams,
	type CreateDriveReplyParams,
	type DeleteDriveCommentParams,
	type DriveAbout,
	type DriveComment,
	type DriveCommentList,
	type DriveCommentReply,
	type DriveFileMedia,
	type DrivePermissionList,
	type DrivePermissionRole,
	type DrivePermissionType,
	type DriveReplyList,
	type GetDriveAboutParams,
	type GetDriveCommentParams,
	type ListDriveCommentsParams,
	type ListDriveRepliesParams,
	type LocalFileReader,
	type LocalFileReadResult,
	type UpdateDriveCommentParams,
	type UpdateDriveFileContentParams,
	type UploadDriveFileOptions,
	type UploadDriveFileParams,
};

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API_BASE = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const UTF8_ENCODER = new TextEncoder();
export interface GoogleDriveAdapterConfig extends GoogleTokenSourceConfig {
	sleepFn?: (ms: number) => Promise<void>;
}

function buildMultipartBody(
	boundary: string,
	metadata: Record<string, unknown>,
	mediaType: string,
	mediaBody: Uint8Array | string,
): Uint8Array {
	const preamble = UTF8_ENCODER.encode(
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`,
	);
	const payload = typeof mediaBody === "string" ? UTF8_ENCODER.encode(mediaBody) : mediaBody;
	const epilogue = UTF8_ENCODER.encode(`\r\n--${boundary}--`);
	const body = new Uint8Array(preamble.byteLength + payload.byteLength + epilogue.byteLength);
	body.set(preamble, 0);
	body.set(payload, preamble.byteLength);
	body.set(epilogue, preamble.byteLength + payload.byteLength);
	return body;
}

interface GoogleErrorBody {
	error?: {
		code?: number; message?: string; status?: string; reason?: string;
		errors?: Array<{ reason?: string; message?: string }>; details?: Array<{ reason?: string }>;
	};
}

interface SpreadsheetSheetData {
	sheetId: number;
	title: string;
	index: number;
	hidden: boolean;
	sheetType: string;
	values: string[][];
}

function escapeCsvField(val: string): string {
	if (val.includes(",") || val.includes('"') || val.includes("\n") || val.includes("\r")) {
		return `"${val.replace(/"/g, '""')}"`;
	}
	return val;
}

function renderSpreadsheetMarkdown(sheets: SpreadsheetSheetData[]): string {
	if (sheets.length === 0) return "(empty)";
	const sections = sheets.map((sheet) => {
		const heading = sheet.hidden ? `## ${sheet.title} (hidden)` : `## ${sheet.title}`;
		if (sheet.sheetType !== "GRID") {
			return `${heading}\n\n(chart sheet: no cell data)`;
		}
		if (sheet.values.length === 0 || sheet.values.every((row) => row.length === 0)) {
			return `${heading}\n\n(empty)`;
		}
		const csvLines = sheet.values.map((row) => row.map(escapeCsvField).join(","));
		return `${heading}\n\n\`\`\`csv\n${csvLines.join("\n")}\n\`\`\``;
	});
	return sections.join("\n\n");
}

export function createGoogleDriveAdapter(config: GoogleDriveAdapterConfig): DrivePort {
	const tokenSource = createGoogleTokenSource(config);
	const sleep = config.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	async function throwDriveError(res: Response, domain?: Domain, token?: string): Promise<never> {
		const text = await res.text();
		let detail = text || res.statusText;
		let reason: string | undefined;
		let googleStatus: string | undefined;
		try {
			const parsed = JSON.parse(text) as GoogleErrorBody;
			if (parsed.error?.message) detail = parsed.error.message;
			reason = parsed.error?.reason ?? parsed.error?.errors?.[0]?.reason ?? parsed.error?.details?.[0]?.reason;
			googleStatus = parsed.error?.status;
		} catch (parseErr) {
			void parseErr;
		}
		detail = detail.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
		if (token) detail = detail.split(token).join("[REDACTED]");
		if (res.status === 404 && domain) {
			detail = `not found in the ${domain} account, or not shared with it (${detail})`;
		} else if (res.status === 403 && (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
			detail = `insufficient permissions for scope ${DRIVE_SCOPE} (${detail})`;
		}
		throw new DriveApiError(`Google Drive API error (HTTP ${res.status}): ${detail}`, res.status, reason, googleStatus);
	}

	async function isRetryableReadResponse(res: Response): Promise<boolean> {
		if (res.status === 429 || res.status >= 500) return true;
		if (res.status !== 403) return false;
		try {
			const parsed = JSON.parse(await res.clone().text()) as GoogleErrorBody;
			const reason = parsed.error?.reason ?? parsed.error?.errors?.[0]?.reason ?? parsed.error?.details?.[0]?.reason;
			return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
		} catch {
			return false;
		}
	}

	async function fetchDriveGet(domain: Domain, url: string, acceptJson = false): Promise<{ res: Response; accessToken: string }> {
		const fetchImpl = config.fetchFn ?? globalThis.fetch;
		const accessToken = await tokenSource.accessToken(domain);
		const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
		if (acceptJson) headers.Accept = "application/json";
		const init = { method: "GET", headers };
		let res = await fetchImpl(url, init);
		for (let retry = 0; retry < 2 && (await isRetryableReadResponse(res)); retry++) {
			await sleep(250 * (retry + 1));
			res = await fetchImpl(url, init);
		}
		return { res, accessToken };
	}

	async function requestDrive<T>(domain: Domain, path: string, query: Record<string, string | number | boolean | undefined>): Promise<T> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
		const { res, accessToken } = await fetchDriveGet(domain, `${DRIVE_API_BASE}${path}?${qs.toString()}`, true);
		if (!res.ok) await throwDriveError(res, domain, accessToken);
		return (await res.json()) as T;
	}

	async function readBinaryResponse(res: Response, maxBytes?: number, domain?: Domain, accessToken?: string): Promise<Uint8Array> {
		if (!res.ok) await throwDriveError(res, domain, accessToken);
		const contentLengthHeader = res.headers.get("content-length");
		if (maxBytes !== undefined && contentLengthHeader !== null) {
			const contentLength = Number(contentLengthHeader);
			if (Number.isFinite(contentLength) && contentLength > maxBytes) {
				throw new DriveApiError(
					`Google Drive file exceeds maximum download size of ${maxBytes} bytes (Content-Length ${contentLength})`,
					413,
				);
			}
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
			throw new DriveApiError(
				`Google Drive file exceeds maximum download size of ${maxBytes} bytes (got ${bytes.byteLength} bytes)`,
				413,
			);
		}
		return bytes;
	}

	async function downloadRawMedia(domain: Domain, fileId: string, maxBytes?: number): Promise<Uint8Array> {
		const qs = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
		const { res, accessToken } = await fetchDriveGet(domain, `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${qs.toString()}`);
		return readBinaryResponse(res, maxBytes, domain, accessToken);
	}

	async function readSpreadsheetAsMarkdown(domain: Domain, spreadsheetId: string): Promise<string> {
		const accessToken = await tokenSource.accessToken(domain);
		const label = domain === "work" ? "work" : "personal";
		const clientOpts = { accessToken, label, fetchFn: config.fetchFn };
		const meta = await getSpreadsheetMetadata(spreadsheetId, clientOpts);
		const gridSheets = meta.sheets.filter((s: SheetTab) => s.sheetType === "GRID");
		const valueRangesMap = new Map<string, string[][]>();
		if (gridSheets.length > 0) {
			const ranges = gridSheets.map((s: SheetTab) => quoteSheetTitle(s.title));
			const valueRanges = await batchGetValues(spreadsheetId, ranges, "FORMATTED_VALUE", clientOpts);
			for (let i = 0; i < gridSheets.length; i++) {
				const sheet = gridSheets[i];
				const vr = valueRanges[i];
				const rawRows = vr?.values ?? [];
				const rows: string[][] = rawRows.map((row) =>
					row.map((cell) => (cell == null ? "" : String(cell))),
				);
				valueRangesMap.set(sheet.title, rows);
			}
		}
		const sheets: SpreadsheetSheetData[] = meta.sheets.map((s: SheetTab) => ({
			sheetId: s.sheetId,
			title: s.title,
			index: s.index,
			hidden: s.hidden,
			sheetType: s.sheetType,
			values: valueRangesMap.get(s.title) ?? [],
		}));
		return renderSpreadsheetMarkdown(sheets);
	}

	async function downloadFileByMime(
		domain: Domain,
		fileId: string,
		mimeType: string | null | undefined,
		maxBytes?: number,
	): Promise<DownloadedDriveFile> {
		if (isFolder(mimeType)) {
			throw new Error(`File ${fileId} is a folder and has no content to download.`);
		}

		if (mimeType === "application/vnd.google-apps.document") {
			const label = domain === "work" ? "work" : "personal";
			const doc = await readDocument(fileId, {
				label,
				accessToken: () => tokenSource.accessToken(domain),
				fetchFn: config.fetchFn,
			});
			return {
				bytes: new TextEncoder().encode(doc.text),
				mimeType: "text/markdown",
				extension: "md",
			};
		}

		if (mimeType === "application/vnd.google-apps.spreadsheet") {
			const text = await readSpreadsheetAsMarkdown(domain, fileId);
			return {
				bytes: new TextEncoder().encode(text),
				mimeType: "text/markdown",
				extension: "md",
			};
		}

		if (isGoogleDoc(mimeType)) {
			const target = GOOGLE_EXPORT[mimeType ?? ""];
			if (!target) {
				throw new Error(`Google-native file type "${mimeType}" cannot be exported by these tools.`);
			}
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ mimeType: target.mimeType });
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export?${qs.toString()}`, {
				method: "GET",
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			const bytes = await readBinaryResponse(res, maxBytes);
			return {
				bytes,
				mimeType: target.mimeType,
				extension: target.extension,
			};
		}

		const bytes = await downloadRawMedia(domain, fileId, maxBytes);
		return {
			bytes,
			mimeType: mimeType ?? "application/octet-stream",
			extension: null,
		};
	}

	function downloadFile(domain: Domain, fileId: string, mimeType?: string | null): Promise<DownloadedDriveFile>;
	function downloadFile(params: DownloadDriveFileWithMimeParams): Promise<DownloadedDriveFile>;
	function downloadFile(params: DownloadDriveFileParams): Promise<Uint8Array>;
	async function downloadFile(
		domainOrParams: Domain | DownloadDriveFileParams | DownloadDriveFileWithMimeParams,
		maybeFileId?: string,
		maybeMimeType?: string | null,
	): Promise<DownloadedDriveFile | Uint8Array> {
		if (typeof domainOrParams === "string") {
			return downloadFileByMime(domainOrParams, maybeFileId!, maybeMimeType);
		}
		if ("mimeType" in domainOrParams) {
			return downloadFileByMime(
				domainOrParams.domain,
				domainOrParams.fileId,
				domainOrParams.mimeType,
				domainOrParams.maxBytes,
			);
		}
		return downloadRawMedia(domainOrParams.domain, domainOrParams.fileId, domainOrParams.maxBytes);
	}

	return {
		getAbout: ({ domain, fields }: GetDriveAboutParams) =>
			requestDrive<DriveAbout>(domain, "/about", { fields: fields ?? ABOUT_FIELDS }),
		getFile: ({ domain, fileId, fields }: GetDriveFileParams) =>
			requestDrive<DriveFile>(domain, `/files/${encodeURIComponent(fileId)}`, { supportsAllDrives: true, fields: fields ?? FILE_FIELDS }),
		async listFiles({ domain, q, pageSize, pageToken, orderBy, fields }: ListDriveFilesParams): Promise<DriveFileList> {
			const data = await requestDrive<DriveFileList>(domain, "/files", {
				supportsAllDrives: true, includeItemsFromAllDrives: true,
				q, pageSize, pageToken, orderBy, fields: fields ?? LIST_FIELDS,
			});
			return {
				files: data.files ?? [],
				...(data.nextPageToken !== undefined ? { nextPageToken: data.nextPageToken } : {}),
				...(data.incompleteSearch !== undefined ? { incompleteSearch: data.incompleteSearch } : {}),
			};
		},
		async listPermissionsPage({ domain, fileId, pageSize, pageToken, fields }: ListDrivePermissionsParams): Promise<DrivePermissionList> {
			const data = await requestDrive<DrivePermissionList>(
				domain, `/files/${encodeURIComponent(fileId)}/permissions`,
				{ supportsAllDrives: true, pageSize, pageToken, fields: fields ?? PERMISSION_FIELDS },
			);
			return {
				permissions: data.permissions ?? [],
				...(data.nextPageToken !== undefined ? { nextPageToken: data.nextPageToken } : {}),
			};
		},
		async listPermissions({ domain, fileId, pageSize, pageToken, fields }: ListDrivePermissionsParams): Promise<DrivePermission[]> {
			const data = await requestDrive<{ permissions?: DrivePermission[] }>(
				domain, `/files/${encodeURIComponent(fileId)}/permissions`,
				{ supportsAllDrives: true, pageSize, pageToken, fields: fields ?? PERMISSION_FIELDS },
			);
			return data.permissions ?? [];
		},
		async updateFileContent({
			domain, fileId, mimeType, body: mediaBody, keepRevisionForever, boundary = DRIVE_MULTIPART_BOUNDARY, fields,
		}: UpdateDriveFileContentParams): Promise<DriveFile> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({
				uploadType: "multipart", supportsAllDrives: "true", fields: fields ?? FILE_FIELDS,
			});
			if (keepRevisionForever !== undefined) qs.set("keepRevisionForever", String(keepRevisionForever));
			const body = buildMultipartBody(boundary, { mimeType: mimeType.split(";")[0].trim() }, mimeType, mediaBody);
			const res = await fetchImpl(`${DRIVE_UPLOAD_API_BASE}/files/${encodeURIComponent(fileId)}?${qs.toString()}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
					"Content-Type": `multipart/related; boundary=${boundary}`,
				},
				body: body as unknown as BodyInit,
			});
			if (!res.ok) await throwDriveError(res, domain, accessToken);
			return (await res.json()) as DriveFile;
		},
		async createFile(
			domainOrParams: Domain | CreateDriveFileParams,
			maybeMetadata?: CreateDriveFileMetadata,
		): Promise<DriveFile> {
			const params: CreateDriveFileParams =
				typeof domainOrParams === "string"
					? { domain: domainOrParams, ...maybeMetadata! }
					: domainOrParams;
			const { domain, name, mimeType, parents, media, boundary = DRIVE_MULTIPART_BOUNDARY, fields } = params;
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const metadata: Record<string, unknown> = { name };
			if (mimeType !== undefined) metadata.mimeType = mimeType;
			if (parents !== undefined) metadata.parents = parents;

			if (media !== undefined) {
				const qs = new URLSearchParams({
					uploadType: "multipart",
					supportsAllDrives: "true",
					fields: fields ?? FILE_FIELDS,
				});
				const body = buildMultipartBody(boundary, metadata, media.mimeType, media.body);
				const res = await fetchImpl(`${DRIVE_UPLOAD_API_BASE}/files?${qs.toString()}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						Accept: "application/json",
						"Content-Type": `multipart/related; boundary=${boundary}`,
					},
					body: body as unknown as BodyInit,
				});
				if (!res.ok) await throwDriveError(res);
				return (await res.json()) as DriveFile;
			}

			const qs = new URLSearchParams({
				supportsAllDrives: "true",
				fields: fields ?? FILE_FIELDS,
			});
			const res = await fetchImpl(`${DRIVE_API_BASE}/files?${qs.toString()}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(metadata),
			});
			if (!res.ok) await throwDriveError(res);
			return (await res.json()) as DriveFile;
		},
		async copyFile(
			domainOrParams: Domain | CopyDriveFileParams,
			maybeFileId?: string,
			maybeOptions?: CopyDriveFileOptions,
		): Promise<DriveFile> {
			const params: CopyDriveFileParams =
				typeof domainOrParams === "string"
					? { domain: domainOrParams, fileId: maybeFileId!, ...(maybeOptions ?? {}) }
					: domainOrParams;
			const { domain, fileId, name, parents, fields } = params;
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({
				supportsAllDrives: "true",
				fields: fields ?? FILE_FIELDS,
			});
			const body: Record<string, unknown> = {};
			if (name !== undefined) body.name = name;
			if (parents !== undefined) body.parents = parents;
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/copy?${qs.toString()}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) await throwDriveError(res);
			return (await res.json()) as DriveFile;
		},
		async uploadFile(
			domainOrParams: Domain | UploadDriveFileParams,
			maybeOptions?: UploadDriveFileOptions,
		): Promise<DriveFile> {
			const params: UploadDriveFileParams =
				typeof domainOrParams === "string"
					? { domain: domainOrParams, ...maybeOptions! }
					: domainOrParams;
			const {
				domain,
				name,
				folderId,
				parents,
				targetMimeType,
				mimeType,
				data,
				body: mediaBody,
				boundary = DRIVE_MULTIPART_BOUNDARY,
				fields,
			} = params;
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({
				uploadType: "multipart",
				supportsAllDrives: "true",
				fields: fields ?? FILE_FIELDS,
			});
			const resolvedParents = parents ?? (folderId ? [folderId] : undefined);
			const metadata: Record<string, unknown> = { name };
			if (targetMimeType !== undefined) {
				metadata.mimeType = targetMimeType;
			} else if (data !== undefined && mediaBody === undefined) {
				metadata.mimeType = mimeType;
			}
			if (resolvedParents !== undefined) {
				metadata.parents = resolvedParents;
			}
			const body = buildMultipartBody(
				boundary,
				metadata,
				mimeType,
				mediaBody ?? data ?? "",
			);

			const res = await fetchImpl(`${DRIVE_UPLOAD_API_BASE}/files?${qs.toString()}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
					"Content-Type": `multipart/related; boundary=${boundary}`,
				},
				body: body as unknown as BodyInit,
			});
			if (!res.ok) await throwDriveError(res);
			return (await res.json()) as DriveFile;
		},
		downloadFile,
		async exportFile(
			domainOrParams: Domain | ExportDriveFileParams,
			maybeFileId?: string,
			maybeMimeType?: string,
		): Promise<Uint8Array> {
			const params: ExportDriveFileParams =
				typeof domainOrParams === "string"
					? { domain: domainOrParams, fileId: maybeFileId!, mimeType: maybeMimeType! }
					: domainOrParams;
			const { domain, fileId, mimeType, maxBytes } = params;
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ mimeType });
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export?${qs.toString()}`, {
				method: "GET",
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			return readBinaryResponse(res, maxBytes);
		},
		async countDocumentTabs(
			domainOrParams: Domain | CountDocumentTabsParams,
			maybeFileId?: string,
		): Promise<number> {
			const { domain, fileId } =
				typeof domainOrParams === "string"
					? { domain: domainOrParams, fileId: maybeFileId! }
					: domainOrParams;
			const label = domain === "work" ? "work" : "personal";
			return countDocsTabs(fileId, {
				label,
				accessToken: () => tokenSource.accessToken(domain),
				fetchFn: config.fetchFn,
			});
		},
		async updateFile(
			domainOrParams: Domain | UpdateDriveFileParams,
			maybeFileId?: string,
			maybePatch?: UpdateDriveFilePatch,
		): Promise<DriveFile> {
			const params: UpdateDriveFileParams =
				typeof domainOrParams === "string"
					? { domain: domainOrParams, fileId: maybeFileId!, ...(maybePatch ?? {}) }
					: domainOrParams;
			const { domain, fileId, name, trashed, addParents, removeParents, fields } = params;
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({
				supportsAllDrives: "true",
				fields: fields ?? FILE_FIELDS,
			});
			if (addParents !== undefined) qs.set("addParents", addParents);
			if (removeParents !== undefined) qs.set("removeParents", removeParents);
			const body: Record<string, unknown> = {};
			if (name !== undefined) body.name = name;
			if (trashed !== undefined) body.trashed = trashed;
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${qs.toString()}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) await throwDriveError(res);
			return (await res.json()) as DriveFile;
		},
		async trashFile({ domain, fileId, fields }: TrashDriveFileParams): Promise<DriveFile> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({
				supportsAllDrives: "true",
				fields: fields ?? FILE_FIELDS,
			});
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${qs.toString()}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ trashed: true }),
			});
			if (!res.ok) await throwDriveError(res);
			return (await res.json()) as DriveFile;
		},
		async deleteFile(
			domainOrParams: Domain | DeleteDriveFileParams,
			maybeFileId?: string,
		): Promise<void> {
			const { domain, fileId } =
				typeof domainOrParams === "string"
					? { domain: domainOrParams, fileId: maybeFileId! }
					: domainOrParams;
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ supportsAllDrives: "true" });
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${qs.toString()}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			if (!res.ok) await throwDriveError(res);
		},
		async deletePermission(
			domainOrParams: Domain | DeleteDrivePermissionParams,
			maybeFileId?: string,
			maybePermissionId?: string,
		): Promise<void> {
			const { domain, fileId, permissionId } =
				typeof domainOrParams === "string"
					? { domain: domainOrParams, fileId: maybeFileId!, permissionId: maybePermissionId! }
					: domainOrParams;
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ supportsAllDrives: "true" });
			const res = await fetchImpl(
				`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?${qs.toString()}`,
				{
					method: "DELETE",
					headers: { Authorization: `Bearer ${accessToken}` },
				},
			);
			if (!res.ok) await throwDriveError(res);
		},
		async createPermission({
			domain,
			fileId,
			role,
			type,
			emailAddress,
			granteeDomain,
			sendNotificationEmail,
			transferOwnership,
			fields,
		}: CreateDrivePermissionParams): Promise<DrivePermission> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({
				supportsAllDrives: "true",
				fields: fields ?? PERMISSION_CREATE_FIELDS,
			});
			const effectiveTransfer = transferOwnership ?? (role === "owner" ? true : undefined);
			if (effectiveTransfer !== undefined) {
				qs.set("transferOwnership", String(effectiveTransfer));
			}
			if (sendNotificationEmail !== undefined) {
				qs.set("sendNotificationEmail", String(sendNotificationEmail));
			}
			const body: Record<string, unknown> = { role, type };
			if (emailAddress !== undefined) body.emailAddress = emailAddress;
			if (granteeDomain !== undefined) body.domain = granteeDomain;
			const res = await fetchImpl(
				`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?${qs.toString()}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						Accept: "application/json",
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
			if (!res.ok) await throwDriveError(res, domain, accessToken);
			return (await res.json()) as DrivePermission;
		},
		async listRevisions({ domain, fileId, pageSize, pageToken, fields }: ListDriveRevisionsParams): Promise<DriveRevisionList> {
			const data = await requestDrive<DriveRevisionList>(domain, `/files/${encodeURIComponent(fileId)}/revisions`, {
				pageSize, pageToken, fields: fields ?? REVISION_LIST_FIELDS,
			});
			return {
				revisions: data.revisions ?? [],
				...(data.nextPageToken !== undefined ? { nextPageToken: data.nextPageToken } : {}),
			};
		},
		getRevision: ({ domain, fileId, revisionId, fields }: GetDriveRevisionParams) =>
			requestDrive<DriveRevision>(domain, `/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, {
				fields: fields ?? REVISION_FIELDS,
			}),
		async downloadRevision({ domain, fileId, revisionId, exportUrl, maxBytes }: DownloadDriveRevisionParams): Promise<Uint8Array> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			let targetUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?alt=media`;
			if (exportUrl !== undefined) {
				const parsed = new URL(exportUrl);
				if (parsed.protocol !== "https:" || !(parsed.hostname === "googleapis.com" || parsed.hostname.endsWith(".googleapis.com") || parsed.hostname.endsWith(".google.com"))) {
					throw new DriveApiError("Refusing to download Drive revision from untrusted exportUrl", 400);
				}
				targetUrl = parsed.toString();
			}
			const res = await fetchImpl(targetUrl, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
			return readBinaryResponse(res, maxBytes);
		},
		async updateRevision({ domain, fileId, revisionId, keepForever, fields }: UpdateDriveRevisionParams): Promise<DriveRevision> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ fields: fields ?? REVISION_FIELDS });
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?${qs.toString()}`, {
				method: "PATCH",
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
				body: JSON.stringify({ keepForever }),
			});
			if (!res.ok) await throwDriveError(res);
			return (await res.json()) as DriveRevision;
		},
		async deleteRevision({ domain, fileId, revisionId }: DeleteDriveRevisionParams): Promise<void> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			if (!res.ok) await throwDriveError(res);
		},
		async listComments({ domain, fileId, pageSize, pageToken, includeDeleted = false, fields }: ListDriveCommentsParams): Promise<DriveCommentList> {
			const data = await requestDrive<{ comments?: DriveComment[]; nextPageToken?: string | null }>(
				domain, `/files/${encodeURIComponent(fileId)}/comments`,
				{ pageSize, pageToken, includeDeleted, fields: fields ?? COMMENT_LIST_FIELDS },
			);
			return {
				comments: data.comments ?? [],
				...(data.nextPageToken !== undefined ? { nextPageToken: data.nextPageToken } : {}),
			};
		},
		getComment: ({ domain, fileId, commentId, includeDeleted = false, fields }: GetDriveCommentParams) =>
			requestDrive<DriveComment>(
				domain, `/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`,
				{ includeDeleted, fields: fields ?? COMMENT_FIELDS },
			),
		async listReplies({ domain, fileId, commentId, pageSize, pageToken, includeDeleted = false, fields }: ListDriveRepliesParams): Promise<DriveReplyList> {
			const data = await requestDrive<{ replies?: DriveCommentReply[]; nextPageToken?: string | null }>(
				domain, `/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies`,
				{ pageSize, pageToken, includeDeleted, fields: fields ?? REPLY_LIST_FIELDS },
			);
			return {
				replies: data.replies ?? [],
				...(data.nextPageToken !== undefined ? { nextPageToken: data.nextPageToken } : {}),
			};
		},
		async createComment({ domain, fileId, content, quotedFileContent, fields }: CreateDriveCommentParams): Promise<DriveComment> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ fields: fields ?? COMMENT_CREATE_FIELDS });
			const body: Record<string, unknown> = { content, ...(quotedFileContent !== undefined ? { quotedFileContent } : {}) };
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/comments?${qs.toString()}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) await throwDriveError(res, domain, accessToken);
			return (await res.json()) as DriveComment;
		},
		async createReply({ domain, fileId, commentId, content, action, fields }: CreateDriveReplyParams): Promise<DriveCommentReply> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ fields: fields ?? REPLY_CREATE_FIELDS });
			const body: Record<string, unknown> = {
				...(content !== undefined ? { content } : {}),
				...(action !== undefined ? { action } : {}),
			};
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies?${qs.toString()}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) await throwDriveError(res, domain, accessToken);
			return (await res.json()) as DriveCommentReply;
		},
		async updateComment({ domain, fileId, commentId, content, fields }: UpdateDriveCommentParams): Promise<DriveComment> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ fields: fields ?? COMMENT_FIELDS });
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}?${qs.toString()}`, {
				method: "PATCH",
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
				body: JSON.stringify({ content }),
			});
			if (!res.ok) await throwDriveError(res, domain, accessToken);
			return (await res.json()) as DriveComment;
		},
		async deleteComment({ domain, fileId, commentId }: DeleteDriveCommentParams): Promise<void> {
			const fetchImpl = config.fetchFn ?? globalThis.fetch;
			const accessToken = await tokenSource.accessToken(domain);
			const res = await fetchImpl(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			if (!res.ok) await throwDriveError(res, domain, accessToken);
		},
	};
}

import { z } from "zod";
import { domainInput, optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	FILE_FIELDS,
	formatFile,
	GOOGLE_DOC_MIME_TYPE,
	isGoogleDoc,
	type DriveFile,
	type DrivePort,
	type LocalFileReader,
} from "../../ports/drive.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const UTF8_ENCODER = new TextEncoder();

const googleAccountInput = z
	.enum(["personal", "work"])
	.optional()
	.describe(
		"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
	);

// The source formats `convert_to: 'google_doc'` accepts (#1220), keyed by the file
// extension used to infer one when `mime_type` is omitted. Drive's own import list
// for the Docs type is wider (RTF, ODT, legacy .doc, and PDFs or images through
// OCR). This is narrowed to what a render pipeline produces, so a conversion
// nobody meant, such as an OCR pass over a PDF, is refused here in words rather
// than turning into a surprising Doc. A Map rather than an object literal, so an
// extension such as ".constructor" cannot resolve through Object.prototype.
export const GOOGLE_DOC_IMPORT_TYPES = new Map<string, string>([
	["html", "text/html"],
	["htm", "text/html"],
	["md", "text/markdown"],
	["markdown", "text/markdown"],
	["txt", "text/plain"],
	["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
]);
export const GOOGLE_DOC_IMPORT_MIME_TYPES = new Set(GOOGLE_DOC_IMPORT_TYPES.values());

function extensionOf(name: string): string | null {
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

// Inline content that opens with an HTML document marker or a common block-level
// tag. A render's name rarely carries ".html" ("Angus Hally CV", or "CV 2026.09",
// whose "extension" is "09"), and importing HTML as text/plain gives a Doc of
// literal "<h1>" markup with no error. So an HTML body is recognised by how it
// starts. A plain-text or Markdown body does not start this way.
const LEADING_HTML =
	/^\s*(?:<!doctype\s+html|<(?:html|head|body|meta|title|style|h[1-6]|p|div|section|article|header|main|ul|ol|table)\b)/i;

/**
 * The media type a Google Doc conversion uploads as, or a refusal.
 *
 * `mime_type` wins when given. Otherwise the type is inferred from the extension of
 * `local_path` (or of `name`, for inline content). Inline content with no
 * recognisable extension is HTML when it starts like HTML (LEADING_HTML), and
 * otherwise keeps the tool's existing text/plain default. Resolved before any file
 * read or Drive call, so a refused upload has touched nothing.
 */
export function googleDocSourceType(args: {
	name: string;
	content?: string;
	local_path?: string;
	mime_type?: string;
}): string {
	const inferred = GOOGLE_DOC_IMPORT_TYPES.get(extensionOf(args.local_path ?? args.name) ?? "");
	const inlineDefault = LEADING_HTML.test(args.content ?? "") ? "text/html" : "text/plain";
	const source = args.mime_type ?? inferred ?? (args.local_path ? undefined : inlineDefault);
	// Compare the bare type, so "text/html; charset=utf-8" is still HTML.
	const bare = source?.split(";")[0].trim().toLowerCase();
	if (!source || !bare || !GOOGLE_DOC_IMPORT_MIME_TYPES.has(bare)) {
		const got = source
			? `"${source}"`
			: `"${args.local_path}", which has no recognised extension, and no mime_type`;
		throw new Error(
			`convert_to 'google_doc' takes an HTML, Markdown, plain-text or .docx source (${[...GOOGLE_DOC_IMPORT_MIME_TYPES].join(", ")}); got ${got}. Nothing was uploaded.`,
		);
	}
	return source;
}

// A converted Doc drops the source's extension, as Drive's own upload-and-convert
// does, so "CV.html" becomes the Doc "CV" and a later drive_export of it is
// "CV.pdf" rather than "CV.html.pdf".
export function withoutImportExtension(name: string): string {
	const ext = extensionOf(name);
	return ext && GOOGLE_DOC_IMPORT_TYPES.has(ext) ? name.slice(0, -(ext.length + 1)) : name;
}

// Inline content is always encoded as UTF-8, so a text type going into a
// conversion says so. Without a declared charset, Drive's importer may decode
// the bytes as Latin-1, and "résumé" becomes "rÃ©sumÃ©" in the Doc and in every
// export of it. A charset the caller set is left alone.
export function withUtf8Charset(type: string): string {
	return /^text\//i.test(type) && !/;\s*charset=/i.test(type) ? `${type}; charset=utf-8` : type;
}

export const driveUploadFileInput = {
	name: z.string().min(1).describe("Name for the file in Drive."),
	content: z
		.string()
		.optional()
		.describe("Inline text content to upload. Provide this OR local_path."),
	local_path: z
		.string()
		.optional()
		.describe(
			"Absolute path to a local file to upload. Provide this OR content. Takes precedence over content.",
		),
	mime_type: z
		.string()
		.optional()
		.describe("MIME type of the upload (default text/plain for inline content)."),
	parent_id: z
		.string()
		.optional()
		.describe("Destination folder id (default: My Drive root)."),
	convert_to: z
		.enum(["google_doc"])
		.optional()
		.describe(
			"Set 'google_doc' to convert an HTML, Markdown, plain-text or .docx upload into an editable Google Doc (the source type comes from mime_type, else the file extension, else an inline body that starts like HTML). Omit to store the bytes as-is.",
		),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveUploadFileInputSchema = z.object(driveUploadFileInput);
export const driveUploadFileSchema = driveUploadFileInputSchema;
export type DriveUploadFileInput = z.infer<typeof driveUploadFileInputSchema>;

export interface DriveUploadFileOutput extends DriveFile {
	file: DriveFile;
	byteLength: number;
	mimeType: string;
	convertedToGoogleDoc: boolean;
	receipt: { file_ids: string[]; byte_count: number; version: string | null };
}

export interface DriveUploadFilePorts {
	drive: DrivePort;
	readLocalFile?: LocalFileReader;
}

function resolveDriveUploadFilePorts(
	portOrDeps: DrivePort | DriveUploadFilePorts,
	maybeReadLocalFile?: LocalFileReader,
): DriveUploadFilePorts {
	if ("drive" in portOrDeps && portOrDeps.drive) {
		return {
			drive: portOrDeps.drive,
			readLocalFile: portOrDeps.readLocalFile ?? maybeReadLocalFile,
		};
	}
	const drive = portOrDeps as DrivePort;
	return {
		drive,
		readLocalFile: maybeReadLocalFile ?? drive.readLocalFile,
	};
}

export function formatDriveUploadFileMcp(out: DriveUploadFileOutput): string {
	const file = out.file ?? out;
	if (out.convertedToGoogleDoc) {
		const link = file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`;
		return `Uploaded ${out.byteLength} bytes (${out.mimeType}) and converted them to a Google Doc:\n${formatFile(file)}\nLink: ${link}`;
	}
	return `Uploaded ${out.byteLength} bytes:\n${formatFile(file)}`;
}

export function createDriveUploadFileAction(
	portOrDeps: DrivePort | DriveUploadFilePorts,
	maybeReadLocalFile?: LocalFileReader,
): ActionDefinition<typeof driveUploadFileInputSchema, DriveUploadFileOutput> {
	const { drive, readLocalFile } = resolveDriveUploadFilePorts(
		portOrDeps,
		maybeReadLocalFile,
	);

	return defineAction({
		id: "drive_upload_file",
		domain: "integrations",
		description:
			"Upload a new file to Google Drive from inline text content or a local file path. Set " +
			"convert_to 'google_doc' to turn an HTML, Markdown, plain-text or .docx upload into an " +
			"editable Google Doc; drive_export then renders it to PDF or DOCX.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: driveUploadFileInputSchema,
		formatMcp: formatDriveUploadFileMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";

			if (!input.local_path && input.content === undefined) {
				throw new Error("Provide either `content` (inline text) or `local_path`.");
			}

			const sourceType =
				input.convert_to === "google_doc" ? googleDocSourceType(input) : null;

			let body: Uint8Array;
			let mimeType: string;
			let name = input.name;
			if (input.local_path) {
				if (!readLocalFile) {
					throw new Error(
						"drive_upload_file cannot read local_path because no readLocalFile reader is wired in this process.",
					);
				}
				const local = await readLocalFile(input.local_path);
				body = local.bytes;
				mimeType = sourceType ?? input.mime_type ?? "application/octet-stream";
				// If the caller gave a placeholder name, fall back to the file's basename.
				if (!name) name = local.name;
			} else {
				body = UTF8_ENCODER.encode(input.content ?? "");
				mimeType = sourceType ? withUtf8Charset(sourceType) : (input.mime_type ?? "text/plain");
			}
			if (sourceType) name = withoutImportExtension(name);

			const file = await drive.uploadFile({
				domain,
				name,
				parents: input.parent_id ? [input.parent_id] : undefined,
				// Drive converts on upload when the file's TARGET type differs from the
				// media's type: the bytes go up as HTML/Markdown/DOCX and land as a Doc.
				// Without convert_to the key is absent, exactly as before #1220.
				...(sourceType ? { targetMimeType: GOOGLE_DOC_MIME_TYPE } : {}),
				mimeType,
				body,
				fields: FILE_FIELDS,
			});

			return {
				...file,
				file,
				byteLength: body.byteLength,
				mimeType,
				convertedToGoogleDoc: Boolean(sourceType),
				receipt: {
					file_ids: file.id ? [file.id] : [],
					byte_count: body.byteLength,
					version: file.version ?? null,
				},
			};
		},
	});
}

// ---- drive_update_content -------------------------------------------------

function decodeBase64(b64: string): Uint8Array {
	const bin = globalThis.atob(b64.replace(/\s+/g, ""));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

export const driveUpdateContentInputSchema = z.object({
	domain: domainInput,
	file_id: z.string().min(1).describe("Google Drive file id to replace content for."),
	text: z.string().optional().describe("UTF-8 text content. Provide text or content_base64."),
	content_base64: z.string().min(1).optional().describe("Base64-encoded binary content. Provide text or content_base64."),
	mime_type: z.string().min(1).describe("Media MIME type for the new revision."),
	expected_version: z.string().min(1).describe("Current file version from drive_get_metadata; refuses on mismatch."),
	keep_revision_forever: z.boolean().optional().describe("Pin the new revision so Drive never auto-purges it."),
});
export type DriveUpdateContentInput = z.infer<typeof driveUpdateContentInputSchema>;
export interface DriveUpdateContentOutput {
	domain: Domain;
	file_id: string;
	file_ids: string[];
	byte_count: number;
	version: string | null;
	keep_revision_forever: boolean;
}

export function formatDriveUpdateContentMcp(out: DriveUpdateContentOutput): string {
	return `Updated ${out.file_id} (${out.byte_count} bytes, version ${out.version ?? "unknown"}${out.keep_revision_forever ? ", keep_revision_forever=true" : ""}).`;
}

export function createDriveUpdateContentAction(
	portOrDeps: DrivePort | { drive: DrivePort },
): ActionDefinition<typeof driveUpdateContentInputSchema, DriveUpdateContentOutput> {
	const drive = "drive" in portOrDeps ? portOrDeps.drive : portOrDeps;
	return defineAction({
		id: "drive_update_content",
		name: "Update Google Drive File Content",
		domain: "integrations",
		description:
			"Replace an existing non-Google-native Drive file's content as a new revision when its current version matches expected_version; refuses if the file changed since you read it or is a Google Doc/Sheet/Slide. Requires domain, file_id, mime_type, expected_version, and text or content_base64. Full notes: docs/guides/tools/drive_update_content.md",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		schema: driveUpdateContentInputSchema,
		formatMcp: formatDriveUpdateContentMcp,
		async run(input) {
			if ((input.text !== undefined) === (input.content_base64 !== undefined)) {
				throw new Error("Provide exactly one of `text` or `content_base64`.");
			}
			if (isGoogleDoc(input.mime_type)) {
				throw new Error(
					`Google-native files (${input.mime_type}) cannot be updated via drive_update_content; edit them with Docs or Sheets tools.`,
				);
			}
			const body = input.text !== undefined ? UTF8_ENCODER.encode(input.text) : decodeBase64(input.content_base64!);
			const current = await drive.getFile({
				domain: input.domain,
				fileId: input.file_id,
				fields: "id, mimeType, version",
			});
			if (isGoogleDoc(current.mimeType)) {
				throw new Error(
					`Google-native files (${current.mimeType}) cannot be updated via drive_update_content; edit them with Docs or Sheets tools.`,
				);
			}
			if (!current.version || String(current.version) !== input.expected_version) {
				throw new Error(
					`Refusing to overwrite ${input.file_id}: the file changed since you read it (expected version ${input.expected_version}, current version ${current.version ?? "unknown"}).`,
				);
			}
			const updated = await drive.updateFileContent!({
				domain: input.domain,
				fileId: input.file_id,
				mimeType: input.mime_type,
				body,
				keepRevisionForever: input.keep_revision_forever,
				fields: "id, mimeType, size, version, modifiedTime",
			});
			return {
				domain: input.domain,
				file_id: input.file_id,
				file_ids: [input.file_id],
				byte_count: body.byteLength,
				version: updated.version ?? null,
				keep_revision_forever: Boolean(input.keep_revision_forever),
			};
		},
	});
}

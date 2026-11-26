import { z } from "zod";
import {
	detectOfficeOpenXmlKind,
	extractOfficeOpenXmlText,
} from "../../domain/extract/office.js";
import type { OneDriveItem, OneDrivePort } from "../../ports/onedrive.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";

const DEFAULT_MAX_CHARS = 50_000;
const MIN_MAX_CHARS = 100;
const MAX_MAX_CHARS = 200_000;
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

const TEXT_LIKE_EXACT_MIMES = new Set([
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/xhtml+xml",
	"application/javascript",
	"application/x-javascript",
	"application/typescript",
	"application/x-yaml",
	"application/yaml",
	"application/sql",
	"application/toml",
	"application/x-sh",
	"image/svg+xml",
]);

const TEXT_LIKE_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".jsonl",
	".yaml",
	".yml",
	".toml",
	".xml",
	".csv",
	".tsv",
	".sql",
	".js",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".jsx",
	".py",
	".sh",
	".html",
	".htm",
	".css",
	".svg",
	".ini",
	".conf",
	".log",
]);

function extractBaseMime(mimeType: string | undefined): string {
	return (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function extractExtension(fileName: string | undefined): string {
	if (!fileName) return "";
	const idx = fileName.lastIndexOf(".");
	return idx >= 0 ? fileName.slice(idx).toLowerCase() : "";
}

export function isTextLikeOneDriveFile(
	mimeType: string | undefined,
	fileName?: string,
): boolean {
	const baseMime = extractBaseMime(mimeType);
	if (baseMime.startsWith("text/") || TEXT_LIKE_EXACT_MIMES.has(baseMime)) {
		return true;
	}
	if (!baseMime || baseMime === "application/octet-stream") {
		return TEXT_LIKE_EXTENSIONS.has(extractExtension(fileName));
	}
	return false;
}

export const onedriveGetMetadataInputSchema = z.object({
	item_id: z
		.string()
		.min(1)
		.optional()
		.describe("OneDrive item ID (or 'root'). Provide either item_id or path."),
	path: z
		.string()
		.min(1)
		.optional()
		.describe(
			"OneDrive root-relative item path (for example '/1.Projects/notes.md'). Provide either item_id or path.",
		),
});

export type OnedriveGetMetadataInput = z.infer<
	typeof onedriveGetMetadataInputSchema
>;

/**
 * Create the `onedrive_get_metadata` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveGetMetadataAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveGetMetadataInputSchema, OneDriveItem> {
	return defineAction({
		id: "onedrive_get_metadata",
		name: "onedrive_get_metadata",
		description:
			"Get metadata for a personal OneDrive file or folder by item_id or root-relative path, including size, timestamps, parentReference, folder.childCount, and file.hashes (sha256Hash, quickXorHash).",
		domain: "integrations",
		schema: onedriveGetMetadataInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveGetMetadataInput,
			_context: ActionContext,
		): Promise<OneDriveItem> {
			const itemId = input.item_id?.trim();
			const path = input.path?.trim();
			if (!itemId && !path) {
				throw new Error(
					"onedrive_get_metadata requires either item_id or path",
				);
			}
			return port.getItemMetadata({
				itemId: itemId || undefined,
				path: path || undefined,
			});
		},
	});
}

export const onedriveReadFileInputSchema = z.object({
	item_id: z
		.string()
		.min(1)
		.describe("OneDrive file item ID to read as UTF-8 text."),
	max_chars: z
		.number()
		.int()
		.min(MIN_MAX_CHARS)
		.max(MAX_MAX_CHARS)
		.optional()
		.describe(
			`Maximum UTF-8 characters to return (${MIN_MAX_CHARS}..${MAX_MAX_CHARS}, default ${DEFAULT_MAX_CHARS}).`,
		),
});

export type OnedriveReadFileInput = z.infer<typeof onedriveReadFileInputSchema>;

export interface OnedriveReadFileOutput {
	item: OneDriveItem;
	mime_type: string;
	content: string;
	total_chars: number;
	truncated: boolean;
}

/**
 * Create the `onedrive_read_file` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveReadFileAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveReadFileInputSchema, OnedriveReadFileOutput> {
	return defineAction({
		id: "onedrive_read_file",
		name: "onedrive_read_file",
		description:
			"Read a text-like file from personal OneDrive as UTF-8 text (up to max_chars). Refuses folders and binary MIME types.",
		domain: "integrations",
		schema: onedriveReadFileInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveReadFileInput,
			_context: ActionContext,
		): Promise<OnedriveReadFileOutput> {
			const maxChars = input.max_chars ?? DEFAULT_MAX_CHARS;
			const item = await port.getItemMetadata({ itemId: input.item_id });

			if (item.folder) {
				throw new Error(
					`onedrive_read_file cannot read folder "${item.name}" (${item.id}); use onedrive_list instead`,
				);
			}

			const declaredMime = item.file?.mimeType;
			const declaredOfficeKind = detectOfficeOpenXmlKind(declaredMime, item.name);
			if (!declaredOfficeKind && !isTextLikeOneDriveFile(declaredMime, item.name)) {
				throw new Error(
					`onedrive_read_file only supports text-like files and .docx, .xlsx, .pptx Office files; refused binary file "${item.name}" (${item.id}) with MIME type "${declaredMime ?? "application/octet-stream"}"`,
				);
			}

			if (typeof item.size === "number" && item.size > MAX_READ_FILE_BYTES) {
				throw new Error(
					`onedrive_read_file refuses files larger than ${MAX_READ_FILE_BYTES} bytes (got ${item.size} bytes for "${item.name}").`,
				);
			}

			const downloaded = await port.downloadItemBytes({
				itemId: input.item_id,
				maxBytes: MAX_READ_FILE_BYTES,
			});
			const effectiveName = downloaded.item.name || item.name;
			const effectiveMime = downloaded.mimeType || declaredMime || "text/plain";
			const officeKind =
				detectOfficeOpenXmlKind(effectiveMime, effectiveName) ?? declaredOfficeKind;
			if (!officeKind && !isTextLikeOneDriveFile(effectiveMime, effectiveName)) {
				throw new Error(
					`onedrive_read_file only supports text-like files and .docx, .xlsx, .pptx Office files; refused binary file "${effectiveName}" (${item.id}) with MIME type "${effectiveMime}"`,
				);
			}

			const fullText = officeKind
				? await extractOfficeOpenXmlText(downloaded.bytes, officeKind)
				: new TextDecoder("utf-8").decode(downloaded.bytes);
			const truncated = fullText.length > maxChars;

			return {
				item: downloaded.item,
				mime_type: effectiveMime,
				content: truncated ? fullText.slice(0, maxChars) : fullText,
				total_chars: fullText.length,
				truncated,
			};
		},
	});
}

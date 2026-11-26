import { z } from "zod";
import type { OneDriveItem, OneDrivePort } from "../../ports/onedrive.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const onedriveConflictBehaviorSchema = z.enum([
	"fail",
	"replace",
	"rename",
]);

export const onedriveCreateFolderInputSchema = z.object({
	name: z.string().min(1).describe("Name of the folder to create."),
	parent_id: z
		.string()
		.min(1)
		.optional()
		.describe("Parent folder item ID in personal OneDrive (defaults to 'root')."),
	conflict_behavior: onedriveConflictBehaviorSchema
		.optional()
		.describe(
			"Conflict behavior if a folder with the same name already exists ('fail', 'replace', or 'rename'; default 'fail').",
		),
});

export type OnedriveCreateFolderInput = z.infer<
	typeof onedriveCreateFolderInputSchema
>;

/**
 * Create the `onedrive_create_folder` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveCreateFolderAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveCreateFolderInputSchema, OneDriveItem> {
	return defineAction({
		id: "onedrive_create_folder",
		name: "onedrive_create_folder",
		description:
			"Create a folder in personal OneDrive under parent_id (default 'root').",
		domain: "integrations",
		schema: onedriveCreateFolderInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		async run(
			input: OnedriveCreateFolderInput,
			_context: ActionContext,
		): Promise<OneDriveItem> {
			const name = input.name.trim();
			if (!name) {
				throw new Error("onedrive_create_folder requires a non-empty folder name");
			}
			return port.createFolder({
				name,
				parentId: input.parent_id ?? "root",
				conflictBehavior: input.conflict_behavior ?? "fail",
			});
		},
	});
}

export const onedriveUploadFileInputSchema = z.object({
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Target file name in OneDrive. Required when uploading inline content; defaults to the local file basename when local_path is used.",
		),
	parent_id: z
		.string()
		.min(1)
		.optional()
		.describe("Parent folder item ID in personal OneDrive (defaults to 'root')."),
	content: z
		.string()
		.optional()
		.describe("Inline UTF-8 text content to upload. Provide either content or local_path."),
	local_path: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Local filesystem path to read and upload via OneDrivePort.readLocalFile. Provide either content or local_path.",
		),
	mime_type: z
		.string()
		.min(1)
		.optional()
		.describe("Optional MIME type for the uploaded file."),
	conflict_behavior: onedriveConflictBehaviorSchema
		.optional()
		.describe(
			"Conflict behavior if a file with the same name already exists ('fail', 'replace', or 'rename'; default 'fail').",
		),
});

export type OnedriveUploadFileInput = z.infer<
	typeof onedriveUploadFileInputSchema
>;

/**
 * Create the `onedrive_upload_file` action backed by `OneDrivePort`.
 * Personal-only (`owner@example.com`); omits both `account` and `domain`.
 */
export function createOnedriveUploadFileAction(
	port: OneDrivePort,
): ActionDefinition<typeof onedriveUploadFileInputSchema, OneDriveItem> {
	return defineAction({
		id: "onedrive_upload_file",
		name: "onedrive_upload_file",
		description:
			"Upload a file up to 100 MiB to personal OneDrive from inline UTF-8 content or a local_path.",
		domain: "integrations",
		schema: onedriveUploadFileInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		async run(
			input: OnedriveUploadFileInput,
			_context: ActionContext,
		): Promise<OneDriveItem> {
			const hasInlineContent = input.content !== undefined;
			const hasLocalPath = Boolean(input.local_path?.trim());

			if (hasInlineContent === hasLocalPath) {
				throw new Error(
					"onedrive_upload_file requires exactly one of content or local_path",
				);
			}

			let bytes: Uint8Array;
			let fileName: string;
			let defaultMimeType: string;

			if (hasLocalPath) {
				if (!port.readLocalFile) {
					throw new Error(
						"onedrive_upload_file with local_path is not supported because OneDrivePort.readLocalFile is not wired in this runtime",
					);
				}
				const local = await port.readLocalFile(input.local_path!.trim());
				bytes = local.bytes;
				fileName = input.name?.trim() || local.fileName;
				defaultMimeType = "application/octet-stream";
			} else {
				const explicitName = input.name?.trim();
				if (!explicitName) {
					throw new Error(
						"onedrive_upload_file requires name when uploading inline content",
					);
				}
				bytes = new TextEncoder().encode(input.content!);
				fileName = explicitName;
				defaultMimeType = "text/plain; charset=utf-8";
			}

			if (!fileName) {
				throw new Error("onedrive_upload_file resolved an empty target file name");
			}
			if (bytes.byteLength > MAX_UPLOAD_BYTES) {
				throw new Error(
					`onedrive_upload_file payload (${bytes.byteLength} bytes) exceeds the 100 MiB limit (${MAX_UPLOAD_BYTES} bytes)`,
				);
			}

			return port.uploadFile({
				name: fileName,
				parentId: input.parent_id ?? "root",
				mimeType: input.mime_type ?? defaultMimeType,
				data: bytes,
				conflictBehavior: input.conflict_behavior ?? "fail",
			});
		},
	});
}

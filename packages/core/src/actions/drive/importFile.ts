import { z } from "zod";
import { ARTIFACT_SURFACES, slugify } from "../../domain/artifacts.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain, type Domain } from "../../domain/domains.js";
import { originationFor } from "../../domain/ingest/discoverPointers.js";
import { DRIVE_CONNECTOR_BY_ACCOUNT } from "../../domain/ingest/selection.js";
import type { ArtifactRepository } from "../../ports/artifacts.js";
import {
	FOLDER_MIME_TYPE,
	isFolder,
	type DrivePort,
} from "../../ports/drive.js";
import type { StoragePort } from "../../ports/storage.js";
import {
	DEFAULT_GOOGLE_ACCOUNT,
	googleAccountInput,
	type GoogleAccount,
} from "../appsscript/account.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const IMPORT_FILE_FIELDS =
	"id, name, mimeType, webViewLink, parents, createdTime, modifiedTime";
export const FOLDER_PATH_FIELDS = "id, name, parents, mimeType";

export interface DriveImportFilePorts {
	drive: Pick<
		DrivePort,
		| "getFile"
		| "downloadFile"
		| "listFiles"
		| "createFile"
		| "updateFile"
		| "deleteFile"
	>;
	artifacts: Pick<ArtifactRepository, "insert">;
	storage: Pick<StoragePort, "upload" | "remove" | "publicUrl">;
	ownerId?: string | (() => string | undefined);
	storageBucket?: string | (() => string);
	embedArtifact?: (
		id: string,
		fields: {
			title?: string;
			description?: string;
			plain_text?: string;
		},
	) => Promise<unknown>;
}

export const driveImportFileInput = {
	file_id: z.string().min(1).describe("Drive file id to import into the knowledge store."),
	title: z
		.string()
		.optional()
		.describe(
			"Optional human-friendly title for the artifact, e.g. the semantic rename 'YYYY-MM-DD Issuer What (ref)'. Defaults to the Drive file name. When cleanup is 'move' or 'delete', also renames the Drive file to this value before the cleanup action.",
		),
	cleanup: z
		.enum(["none", "move", "delete"])
		.optional()
		.describe(
			"What to do with the Drive original after the artifact is confirmed persisted. 'none' (default): leave untouched. 'move': move to a 'Sorted/' subfolder of the file's parent (creates it if missing). 'delete': permanently delete (bypasses Trash, not recoverable).",
		),
	tags: z.array(z.string()).optional().describe("Optional tags for the artifact."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const driveImportFileSchema = z.object(driveImportFileInput);
export type DriveImportFileInput = z.infer<typeof driveImportFileSchema>;

export interface DriveImportFileOutput {
	artifact_id: string;
	artifact_title: string;
	storage_bucket: string;
	storage_path: string;
	storage_url: string;
	file_size: number;
	mime_type: string;
	textual: boolean;
	processing_status: string;
	drive_file_id: string;
	drive_file_name: string;
	cleanup: "none" | "move" | "delete";
	cleanup_lines: string[];
}

function isTextual(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml"
	);
}

function deriveExtension(name: string, exported: string | null): string | null {
	if (exported) return exported;
	const dot = name.lastIndexOf(".");
	if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
	return null;
}

async function loadFolderPath(
	drive: Pick<DrivePort, "getFile">,
	domain: Domain,
	folderId: string,
): Promise<{ ids: string[]; path: string | null }> {
	const ids: string[] = [];
	const names: string[] = [];
	let currentId = folderId;

	for (let depth = 0; depth < 20; depth += 1) {
		const meta = await drive.getFile({
			domain,
			fileId: currentId,
			fields: FOLDER_PATH_FIELDS,
		});
		if (!isFolder(meta.mimeType)) break;

		const id = meta.id ?? currentId;
		ids.unshift(id);
		names.unshift(meta.name ?? id);

		const parentId = meta.parents?.[0];
		if (!parentId || parentId === "root" || parentId === currentId) break;
		currentId = parentId;
	}

	return { ids, path: names.length ? names.join(" / ") : null };
}

async function ensureSortedFolder(
	drive: Pick<DrivePort, "listFiles" | "createFile">,
	domain: Domain,
	parentId: string,
): Promise<string> {
	const res = await drive.listFiles({
		domain,
		q: `name = 'Sorted' and mimeType = '${FOLDER_MIME_TYPE}' and '${parentId}' in parents and trashed = false`,
		fields: "files(id)",
	});
	if (res.files && res.files.length > 0 && res.files[0].id) {
		return res.files[0].id;
	}
	const created = await drive.createFile({
		domain,
		name: "Sorted",
		mimeType: FOLDER_MIME_TYPE,
		parents: [parentId],
		fields: "id",
	});
	if (!created.id) {
		throw new Error("Drive folder creation returned no id.");
	}
	return created.id;
}

export function formatDriveImportFileMcp(out: DriveImportFileOutput): string {
	const next = out.textual
		? "Text stored and searchable now."
		: "Binary stored \u2014 call artifact_extract_text with this id to make it searchable.";
	const cleanupNote =
		out.cleanup_lines.length > 0 ? `\n${out.cleanup_lines.join("\n")}` : "";
	return (
		`Imported "${out.artifact_title}" from Drive as artifact ${out.artifact_id}.\n` +
		`Stored ${out.file_size} bytes (${out.mime_type}) at ${out.storage_bucket}/${out.storage_path}.\n` +
		`${next}${cleanupNote}`
	);
}

export function createDriveImportFileAction(
	ports: DriveImportFilePorts,
): ActionDefinition<typeof driveImportFileSchema, DriveImportFileOutput> {
	return defineAction({
		id: "drive_import_file",
		domain: "integrations",
		description:
			"Import a Google Drive file into the knowledge store: downloads or exports it to Storage and " +
			"creates a searchable artifact (run artifact_extract_text afterwards for PDFs and images). Cleanup " +
			"on the Drive original runs only after the artifact is persisted. Parks for the owner's approval " +
			"when cleanup is 'delete'. Full notes: docs/guides/tools/drive_import_file.md",
		needsApproval: (input) => input.cleanup === "delete",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: driveImportFileSchema,
		formatMcp: formatDriveImportFileMcp,
		async run(args, ctx): Promise<DriveImportFileOutput> {
			const domain =
				reconcileDomain(args.domain, args.account, "account") ?? "angus";
			const account: GoogleAccount =
				domain === "work" ? "work" : DEFAULT_GOOGLE_ACCOUNT;

			const meta = await ports.drive.getFile({
				domain,
				fileId: args.file_id,
				fields: IMPORT_FILE_FIELDS,
			});
			const driveName = meta.name ?? "drive-file";
			const driveMime = meta.mimeType ?? "";
			const driveFileId = meta.id ?? args.file_id;
			const parents = meta.parents ?? [];

			if (isFolder(driveMime)) {
				throw new Error(
					`${args.file_id} is a folder \u2014 import individual files instead.`,
				);
			}

			const parentPath = parents[0]
				? (await loadFolderPath(ports.drive, domain, parents[0])).path
				: null;

			const {
				bytes,
				mimeType,
				extension: exportedExt,
			} = await ports.drive.downloadFile({
				domain,
				fileId: args.file_id,
				mimeType: driveMime,
			});

			const userId =
				(ctx?.userId || undefined) ??
				(typeof ports.ownerId === "function"
					? ports.ownerId()
					: ports.ownerId) ??
				"";
			const bucket =
				(typeof ports.storageBucket === "function"
					? ports.storageBucket()
					: ports.storageBucket) ?? "user-uploads";

			const id = globalThis.crypto.randomUUID();
			const ext = deriveExtension(driveName, exportedExt);
			const storagePath = `drive-imports/${userId}/${id}${ext ? `.${ext}` : ""}`;
			const storageUrl = ports.storage.publicUrl(bucket, storagePath);
			const artifactTitle = args.title ?? driveName;
			const filename = `${slugify(artifactTitle)}-${id.slice(0, 8)}${ext ? `.${ext}` : ""}`;
			const sourceUrl =
				meta.webViewLink ?? `https://drive.google.com/file/d/${args.file_id}`;

			try {
				await ports.storage.upload(bucket, storagePath, bytes, {
					contentType: mimeType,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Storage upload failed: ${msg}`);
			}

			const originatedAt = originationFor(DRIVE_CONNECTOR_BY_ACCOUNT[account], {
				source_created_at: meta.createdTime ?? undefined,
				source_modified_at: meta.modifiedTime ?? undefined,
			});

			const textual = isTextual(mimeType);
			const plainText = textual ? new TextDecoder("utf-8").decode(bytes) : null;
			const processingStatus = textual ? "completed" : "pending";

			let inserted: { id: string; title: string };
			try {
				inserted = await ports.artifacts.insert({
					id,
					user_id: userId,
					storage_bucket: bucket,
					storage_path: storagePath,
					storage_url: storageUrl,
					filename,
					original_file_name: driveName,
					file_type: mimeType,
					content_type: mimeType,
					file_extension: ext,
					file_size: bytes.byteLength,
					artifact_type: "original",
					captured_at: new Date().toISOString(),
					...(originatedAt ? { originated_at: originatedAt } : {}),
					source: sourceUrl,
					source_url: sourceUrl,
					source_drive_file_id: driveFileId,
					source_parent_folder_ids: parents,
					source_parent_folder_path: parentPath,
					source_channel: "google_drive",
					surface: ARTIFACT_SURFACES.driveImport,
					lifecycle_stage: "uploaded",
					processing_status: processingStatus,
					title: artifactTitle,
					plain_text: plainText,
					tags: args.tags ?? [],
					content_subtype: null,
				});
			} catch (err) {
				try {
					await ports.storage.remove(bucket, [storagePath]);
				} catch (removeErr) {
					void removeErr;
				}
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Insert failed: ${msg}`);
			}

			const resolvedTitle = inserted.title ?? artifactTitle;

			if (textual && ports.embedArtifact) {
				await ports.embedArtifact(inserted.id, {
					title: resolvedTitle,
					plain_text: plainText ?? undefined,
				});
			}

			const cleanup = args.cleanup ?? "none";
			const cleanupLines: string[] = [];

			if (cleanup === "move" || cleanup === "delete") {
				if (args.title && args.title !== driveName) {
					await ports.drive.updateFile({
						domain,
						fileId: args.file_id,
						name: args.title,
						fields: "id",
					});
					cleanupLines.push(`Renamed Drive file to "${args.title}".`);
				}
			}

			if (cleanup === "move") {
				const parentId = parents[0];
				if (!parentId) {
					cleanupLines.push(
						"Warning: Drive file has no parent \u2014 skipped move to Sorted/.",
					);
				} else {
					const sortedId = await ensureSortedFolder(
						ports.drive,
						domain,
						parentId,
					);
					await ports.drive.updateFile({
						domain,
						fileId: args.file_id,
						addParents: sortedId,
						removeParents: parentId,
						fields: "id",
					});
					cleanupLines.push(`Moved Drive original to Sorted/ (${sortedId}).`);
				}
			} else if (cleanup === "delete") {
				if (!ports.drive.deleteFile) {
					throw new Error("Drive deleteFile port is not wired.");
				}
				await ports.drive.deleteFile(domain, args.file_id);
				cleanupLines.push(`Permanently deleted Drive original ${args.file_id}.`);
			}

			return {
				artifact_id: inserted.id,
				artifact_title: resolvedTitle,
				storage_bucket: bucket,
				storage_path: storagePath,
				storage_url: storageUrl,
				file_size: bytes.byteLength,
				mime_type: mimeType,
				textual,
				processing_status: processingStatus,
				drive_file_id: driveFileId,
				drive_file_name: driveName,
				cleanup,
				cleanup_lines: cleanupLines,
			};
		},
	});
}

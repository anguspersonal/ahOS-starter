import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { DriveFile, DrivePort } from "../../ports/drive.js";
import { isFolder, isGoogleDoc } from "../../ports/drive.js";
import type { OneDriveItem, OneDrivePort } from "../../ports/onedrive.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";

export const MAX_TRANSFER_BATCH_SIZE = 25;
export const MAX_TRANSFER_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB (104,857,600 bytes)

export const GOOGLE_WORKSPACE_OFFICE_EXPORT: Record<
	string,
	{ mimeType: string; extension: string }
> = {
	"application/vnd.google-apps.document": {
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		extension: ".docx",
	},
	"application/vnd.google-apps.spreadsheet": {
		mimeType:
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		extension: ".xlsx",
	},
	"application/vnd.google-apps.presentation": {
		mimeType:
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		extension: ".pptx",
	},
};

export interface OnedriveGdrivePorts {
	onedrive: OneDrivePort;
	drive: DrivePort;
}

export function resolveCrossCloudPorts(
	first: OnedriveGdrivePorts | OneDrivePort,
	second?: DrivePort,
): OnedriveGdrivePorts {
	if (second !== undefined) {
		return { onedrive: first as OneDrivePort, drive: second };
	}
	return first as OnedriveGdrivePorts;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

export function escapeDriveQueryLiteral(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function disambiguateFileName(
	baseName: string,
	takenNamesLower: Set<string>,
): string {
	if (!takenNamesLower.has(baseName.toLowerCase())) {
		return baseName;
	}
	const dotIdx = baseName.lastIndexOf(".");
	const hasExt = dotIdx > 0;
	const stem = hasExt ? baseName.slice(0, dotIdx) : baseName;
	const ext = hasExt ? baseName.slice(dotIdx) : "";
	let counter = 1;
	while (true) {
		const candidate = `${stem} (${counter})${ext}`;
		if (!takenNamesLower.has(candidate.toLowerCase())) {
			return candidate;
		}
		counter += 1;
	}
}

export function resolveExportedOfficeFileName(
	originalName: string,
	extension: string,
): string {
	if (originalName.toLowerCase().endsWith(extension.toLowerCase())) {
		return originalName;
	}
	return `${originalName}${extension}`;
}

async function listAllGdriveFolderFiles(
	drive: DrivePort,
	domain: Domain,
	folderId: string,
): Promise<DriveFile[]> {
	const files: DriveFile[] = [];
	let pageToken: string | undefined;
	const q = `'${escapeDriveQueryLiteral(folderId)}' in parents and trashed = false`;
	do {
		const res = await drive.listFiles({
			domain,
			q,
			pageSize: 200,
			pageToken,
		});
		for (const f of res.files ?? []) {
			if (!f.trashed) {
				files.push(f);
			}
		}
		pageToken = res.nextPageToken ?? undefined;
	} while (pageToken);
	return files;
}

async function listAllOnedriveFolderItems(
	onedrive: OneDrivePort,
	folderId: string,
): Promise<OneDriveItem[]> {
	const items: OneDriveItem[] = [];
	let cursor: string | undefined;
	do {
		const res = await onedrive.listChildren({
			folderId,
			pageSize: 200,
			cursor,
		});
		items.push(...(res.items ?? []));
		cursor = res.nextCursor;
	} while (cursor);
	return items;
}

export const crossCloudIfExistsSchema = z.enum([
	"skip_if_identical",
	"rename",
	"fail",
]);

export type CrossCloudIfExists = z.infer<typeof crossCloudIfExistsSchema>;

export interface CrossCloudTransferItemResult {
	source_id: string;
	destination_id: string | null;
	name: string;
	status: "copied" | "skipped_identical" | "failed";
	size: number;
	sha256: string | null;
	exported?: boolean;
	exported_mime_type?: string;
	cleaned_up?: boolean;
	error?: string;
}

export interface CrossCloudTransferOutput {
	domain: Domain;
	copied_count: number;
	skipped_count: number;
	failed_count: number;
	results: CrossCloudTransferItemResult[];
}

export const onedriveCopyToGdriveInputSchema = z.object({
	item_ids: z
		.array(z.string().min(1))
		.min(1)
		.max(MAX_TRANSFER_BATCH_SIZE)
		.describe(
			`1 to ${MAX_TRANSFER_BATCH_SIZE} personal OneDrive file item IDs to copy to Google Drive.`,
		),
	gdrive_folder_id: z
		.string()
		.min(1)
		.describe("Destination Google Drive folder ID."),
	domain: z
		.enum(DOMAINS)
		.default("angus")
		.describe("Google Drive domain ('work' or 'angus'; default 'angus')."),
	if_exists: crossCloudIfExistsSchema
		.default("skip_if_identical")
		.describe(
			"Conflict behavior if a file with the same name exists in the destination Google Drive folder ('skip_if_identical', 'rename', or 'fail'; default 'skip_if_identical').",
		),
});

export type OnedriveCopyToGdriveInput = z.infer<
	typeof onedriveCopyToGdriveInputSchema
>;

/**
 * Create the `onedrive_copy_to_gdrive` action backed by `OneDrivePort` and `DrivePort`.
 */
export function createOnedriveCopyToGdriveAction(
	portsOrOnedrive: OnedriveGdrivePorts | OneDrivePort,
	maybeDrive?: DrivePort,
): ActionDefinition<
	typeof onedriveCopyToGdriveInputSchema,
	CrossCloudTransferOutput
> {
	const { onedrive, drive } = resolveCrossCloudPorts(
		portsOrOnedrive,
		maybeDrive,
	);

	return defineAction({
		id: "onedrive_copy_to_gdrive",
		name: "onedrive_copy_to_gdrive",
		description:
			"Copy 1 to 25 files (up to 100 MiB each) from personal OneDrive to a Google Drive folder server-side with SHA-256 and byte-size parity verification.",
		domain: "integrations",
		schema: onedriveCopyToGdriveInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveCopyToGdriveInput,
			_context: ActionContext,
		): Promise<CrossCloudTransferOutput> {
			const domain: Domain = input.domain ?? "angus";
			const ifExists: CrossCloudIfExists =
				input.if_exists ?? "skip_if_identical";

			const existingFiles = await listAllGdriveFolderFiles(
				drive,
				domain,
				input.gdrive_folder_id,
			);
			const existingByNameLower = new Map<string, DriveFile>();
			const takenNamesLower = new Set<string>();
			for (const f of existingFiles) {
				if (f.name) {
					const key = f.name.toLowerCase();
					if (!existingByNameLower.has(key)) {
						existingByNameLower.set(key, f);
					}
					takenNamesLower.add(key);
				}
			}

			const results: CrossCloudTransferItemResult[] = [];

			for (const rawId of input.item_ids) {
				const itemId = rawId.trim();
				try {
					const meta = await onedrive.getItemMetadata({ itemId });
					if (meta.folder && !meta.file) {
						throw new Error(
							`OneDrive item "${meta.name}" (${itemId}) is a folder; only files can be copied via onedrive_copy_to_gdrive`,
						);
					}
					if (
						meta.size !== undefined &&
						meta.size > MAX_TRANSFER_FILE_BYTES
					) {
						throw new Error(
							`OneDrive file "${meta.name}" (${meta.size} bytes) exceeds the ${MAX_TRANSFER_FILE_BYTES}-byte per-file transfer limit`,
						);
					}

					const sourceSha256 = meta.file?.hashes?.sha256Hash
						? meta.file.hashes.sha256Hash.toLowerCase()
						: undefined;
					const existing = existingByNameLower.get(meta.name.toLowerCase());

					if (existing) {
						const existingSize =
							existing.size !== undefined && existing.size !== null
								? Number(existing.size)
								: undefined;
						const existingSha256 = existing.sha256Checksum
							? existing.sha256Checksum.toLowerCase()
							: undefined;

						if (ifExists === "skip_if_identical") {
							const sizeMatches =
								meta.size !== undefined &&
								existingSize !== undefined &&
								meta.size === existingSize;
							const hashMatches =
								Boolean(sourceSha256) &&
								Boolean(existingSha256) &&
								sourceSha256 === existingSha256;
							if (sizeMatches && hashMatches) {
								results.push({
									source_id: itemId,
									destination_id: existing.id ?? null,
									name: meta.name,
									status: "skipped_identical",
									size: meta.size ?? 0,
									sha256: sourceSha256 ?? null,
								});
								continue;
							}
							throw new Error(
								`Destination file "${meta.name}" already exists in Google Drive folder ${input.gdrive_folder_id} with different size or SHA-256 checksum`,
							);
						}

						if (ifExists === "fail") {
							throw new Error(
								`Destination file "${meta.name}" already exists in Google Drive folder ${input.gdrive_folder_id}`,
							);
						}
					}

					const targetName =
						existing && ifExists === "rename"
							? disambiguateFileName(meta.name, takenNamesLower)
							: meta.name;

					const downloaded = await onedrive.downloadItemBytes({
						itemId,
						maxBytes: MAX_TRANSFER_FILE_BYTES,
					});
					const bytes = downloaded.bytes;
					if (bytes.byteLength > MAX_TRANSFER_FILE_BYTES) {
						throw new Error(
							`OneDrive file "${meta.name}" (${bytes.byteLength} bytes) exceeds the ${MAX_TRANSFER_FILE_BYTES}-byte per-file transfer limit`,
						);
					}

					const computedSha256 = await sha256Hex(bytes);
					const expectedSourceSize = meta.size ?? downloaded.item.size;
					const expectedSourceSha256 =
						sourceSha256 ??
						downloaded.item.file?.hashes?.sha256Hash?.toLowerCase();

					if (
						expectedSourceSize !== undefined &&
						expectedSourceSize !== bytes.byteLength
					) {
						throw new Error(
							`Source byte size mismatch for "${meta.name}": metadata reported ${expectedSourceSize} bytes, downloaded ${bytes.byteLength} bytes`,
						);
					}
					if (
						expectedSourceSha256 !== undefined &&
						expectedSourceSha256 !== computedSha256
					) {
						throw new Error(
							`Source SHA-256 mismatch for "${meta.name}": metadata reported ${expectedSourceSha256}, computed ${computedSha256}`,
						);
					}

					const mimeType =
						meta.file?.mimeType ??
						downloaded.mimeType ??
						"application/octet-stream";

					const uploaded = await drive.uploadFile({
						domain,
						name: targetName,
						folderId: input.gdrive_folder_id,
						mimeType,
						data: bytes,
					});

					const uploadedSize =
						uploaded.size !== undefined && uploaded.size !== null
							? Number(uploaded.size)
							: undefined;
					const uploadedSha256 = uploaded.sha256Checksum
						? uploaded.sha256Checksum.toLowerCase()
						: undefined;

					const destSizeMismatch =
						uploadedSize !== undefined && uploadedSize !== bytes.byteLength;
					const destHashMismatch =
						uploadedSha256 !== undefined && uploadedSha256 !== computedSha256;

					if (destSizeMismatch || destHashMismatch) {
						let cleanedUp = false;
						let cleanupError: string | undefined;
						if (uploaded.id) {
							try {
								await drive.trashFile({ domain, fileId: uploaded.id });
								cleanedUp = true;
							} catch (cleanupErr) {
								cleanupError =
									cleanupErr instanceof Error
										? cleanupErr.message
										: String(cleanupErr);
							}
						}
						const baseError = `Destination parity verification failed for "${targetName}" (expected size=${bytes.byteLength} sha256=${computedSha256}, got size=${uploadedSize ?? "unknown"} sha256=${uploadedSha256 ?? "unknown"})`;
						results.push({
							source_id: itemId,
							destination_id: null,
							name: targetName,
							status: "failed",
							size: bytes.byteLength,
							sha256: computedSha256,
							cleaned_up: cleanedUp,
							error: cleanupError
								? `${baseError}; cleanup failed: ${cleanupError}`
								: baseError,
						});
						continue;
					}

					takenNamesLower.add(targetName.toLowerCase());
					existingByNameLower.set(targetName.toLowerCase(), uploaded);

					results.push({
						source_id: itemId,
						destination_id: uploaded.id ?? null,
						name: uploaded.name ?? targetName,
						status: "copied",
						size: bytes.byteLength,
						sha256: computedSha256,
					});
				} catch (err) {
					results.push({
						source_id: itemId,
						destination_id: null,
						name: itemId,
						status: "failed",
						size: 0,
						sha256: null,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			return {
				domain,
				copied_count: results.filter((r) => r.status === "copied").length,
				skipped_count: results.filter((r) => r.status === "skipped_identical")
					.length,
				failed_count: results.filter((r) => r.status === "failed").length,
				results,
			};
		},
	});
}

export const gdriveCopyToOnedriveInputSchema = z.object({
	file_ids: z
		.array(z.string().min(1))
		.min(1)
		.max(MAX_TRANSFER_BATCH_SIZE)
		.describe(
			`1 to ${MAX_TRANSFER_BATCH_SIZE} Google Drive file IDs to copy to personal OneDrive.`,
		),
	onedrive_parent_id: z
		.string()
		.min(1)
		.default("root")
		.describe(
			"Destination personal OneDrive parent folder item ID (defaults to 'root').",
		),
	domain: z
		.enum(DOMAINS)
		.default("angus")
		.describe("Google Drive domain ('work' or 'angus'; default 'angus')."),
	if_exists: crossCloudIfExistsSchema
		.default("skip_if_identical")
		.describe(
			"Conflict behavior if a file with the same name exists in the destination OneDrive folder ('skip_if_identical', 'rename', or 'fail'; default 'skip_if_identical').",
		),
});

export type GdriveCopyToOnedriveInput = z.infer<
	typeof gdriveCopyToOnedriveInputSchema
>;

/**
 * Create the `gdrive_copy_to_onedrive` action backed by `OneDrivePort` and `DrivePort`.
 */
export function createGdriveCopyToOnedriveAction(
	portsOrOnedrive: OnedriveGdrivePorts | OneDrivePort,
	maybeDrive?: DrivePort,
): ActionDefinition<
	typeof gdriveCopyToOnedriveInputSchema,
	CrossCloudTransferOutput
> {
	const { onedrive, drive } = resolveCrossCloudPorts(
		portsOrOnedrive,
		maybeDrive,
	);

	return defineAction({
		id: "gdrive_copy_to_onedrive",
		name: "gdrive_copy_to_onedrive",
		description:
			"Copy 1 to 25 files (up to 100 MiB each) from Google Drive to personal OneDrive server-side, exporting Google Docs/Sheets/Slides to .docx/.xlsx/.pptx and verifying SHA-256 and byte-size parity.",
		domain: "integrations",
		schema: gdriveCopyToOnedriveInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: GdriveCopyToOnedriveInput,
			_context: ActionContext,
		): Promise<CrossCloudTransferOutput> {
			const domain: Domain = input.domain ?? "angus";
			const parentId = input.onedrive_parent_id ?? "root";
			const ifExists: CrossCloudIfExists =
				input.if_exists ?? "skip_if_identical";

			const existingItems = await listAllOnedriveFolderItems(
				onedrive,
				parentId,
			);
			const existingByNameLower = new Map<string, OneDriveItem>();
			for (const item of existingItems) {
				const key = item.name.toLowerCase();
				if (!existingByNameLower.has(key)) {
					existingByNameLower.set(key, item);
				}
			}

			const results: CrossCloudTransferItemResult[] = [];

			for (const rawId of input.file_ids) {
				const fileId = rawId.trim();
				try {
					const gfile = await drive.getFile({ domain, fileId });
					const baseName = gfile.name ?? fileId;

					if (isFolder(gfile.mimeType)) {
						throw new Error(
							`Google Drive item "${baseName}" (${fileId}) is a folder; only files can be copied via gdrive_copy_to_onedrive`,
						);
					}

					const exportSpec = gfile.mimeType
						? GOOGLE_WORKSPACE_OFFICE_EXPORT[gfile.mimeType]
						: undefined;

					if (isGoogleDoc(gfile.mimeType) && !exportSpec) {
						throw new Error(
							`Unsupported Google Workspace native MIME type "${gfile.mimeType}" on file "${baseName}" (${fileId})`,
						);
					}

					const targetName = exportSpec
						? resolveExportedOfficeFileName(baseName, exportSpec.extension)
						: baseName;
					const existing = existingByNameLower.get(targetName.toLowerCase());

					let bytes: Uint8Array;
					let uploadMimeType: string;

					if (exportSpec) {
						bytes = await drive.exportFile({
							domain,
							fileId,
							mimeType: exportSpec.mimeType,
							maxBytes: MAX_TRANSFER_FILE_BYTES,
						});
						uploadMimeType = exportSpec.mimeType;
					} else {
						const declaredSize =
							gfile.size !== undefined && gfile.size !== null
								? Number(gfile.size)
								: undefined;
						if (
							declaredSize !== undefined &&
							declaredSize > MAX_TRANSFER_FILE_BYTES
						) {
							throw new Error(
								`Google Drive file "${baseName}" (${declaredSize} bytes) exceeds the ${MAX_TRANSFER_FILE_BYTES}-byte per-file transfer limit`,
							);
						}

						const sourceSha256 = gfile.sha256Checksum
							? gfile.sha256Checksum.toLowerCase()
							: undefined;

						if (existing) {
							const existingSha256 =
								existing.file?.hashes?.sha256Hash?.toLowerCase();
							if (ifExists === "skip_if_identical") {
								const sizeMatches =
									declaredSize !== undefined &&
									existing.size !== undefined &&
									declaredSize === existing.size;
								const hashMatches =
									Boolean(sourceSha256) &&
									Boolean(existingSha256) &&
									sourceSha256 === existingSha256;
								if (sizeMatches && hashMatches) {
									results.push({
										source_id: fileId,
										destination_id: existing.id,
										name: targetName,
										status: "skipped_identical",
										size: declaredSize ?? 0,
										sha256: sourceSha256 ?? null,
										exported: false,
									});
									continue;
								}
								throw new Error(
									`Destination file "${targetName}" already exists in OneDrive folder ${parentId} with different size or SHA-256 hash`,
								);
							}
							if (ifExists === "fail") {
								throw new Error(
									`Destination file "${targetName}" already exists in OneDrive folder ${parentId}`,
								);
							}
						}

						bytes = await drive.downloadFile({
							domain,
							fileId,
							maxBytes: MAX_TRANSFER_FILE_BYTES,
						});
						uploadMimeType = gfile.mimeType ?? "application/octet-stream";
					}

					if (bytes.byteLength > MAX_TRANSFER_FILE_BYTES) {
						throw new Error(
							`File "${targetName}" (${bytes.byteLength} bytes) exceeds the ${MAX_TRANSFER_FILE_BYTES}-byte per-file transfer limit`,
						);
					}

					const computedSha256 = await sha256Hex(bytes);

					if (!exportSpec) {
						const declaredSize =
							gfile.size !== undefined && gfile.size !== null
								? Number(gfile.size)
								: undefined;
						const declaredSha256 = gfile.sha256Checksum
							? gfile.sha256Checksum.toLowerCase()
							: undefined;
						if (
							declaredSize !== undefined &&
							declaredSize !== bytes.byteLength
						) {
							throw new Error(
								`Source byte size mismatch for "${baseName}": metadata reported ${declaredSize} bytes, downloaded ${bytes.byteLength} bytes`,
							);
						}
						if (
							declaredSha256 !== undefined &&
							declaredSha256 !== computedSha256
						) {
							throw new Error(
								`Source SHA-256 mismatch for "${baseName}": metadata reported ${declaredSha256}, computed ${computedSha256}`,
							);
						}
					} else if (existing) {
						const existingSha256 =
							existing.file?.hashes?.sha256Hash?.toLowerCase();
						if (ifExists === "skip_if_identical") {
							if (
								existing.size === bytes.byteLength &&
								existingSha256 === computedSha256
							) {
								results.push({
									source_id: fileId,
									destination_id: existing.id,
									name: targetName,
									status: "skipped_identical",
									size: bytes.byteLength,
									sha256: computedSha256,
									exported: true,
									exported_mime_type: exportSpec.mimeType,
								});
								continue;
							}
							throw new Error(
								`Destination file "${targetName}" already exists in OneDrive folder ${parentId} with different size or SHA-256 hash`,
							);
						}
						if (ifExists === "fail") {
							throw new Error(
								`Destination file "${targetName}" already exists in OneDrive folder ${parentId}`,
							);
						}
					}

					const uploaded = await onedrive.uploadFile({
						name: targetName,
						parentId,
						mimeType: uploadMimeType,
						data: bytes,
						conflictBehavior: ifExists === "rename" ? "rename" : "fail",
					});

					const uploadedSize = uploaded.size;
					const uploadedSha256 =
						uploaded.file?.hashes?.sha256Hash?.toLowerCase();
					const destSizeMismatch =
						uploadedSize !== undefined && uploadedSize !== bytes.byteLength;
					const destHashMismatch =
						uploadedSha256 !== undefined && uploadedSha256 !== computedSha256;

					if (destSizeMismatch || destHashMismatch) {
						let cleanedUp = false;
						let cleanupError: string | undefined;
						if (uploaded.id) {
							try {
								const delRes = await onedrive.deleteItems({
									itemIds: [uploaded.id],
								});
								cleanedUp =
									delRes.deletedItemIds.includes(uploaded.id) &&
									delRes.failed.length === 0;
								if (!cleanedUp && delRes.failed.length > 0) {
									cleanupError =
										delRes.failed[0].error ??
										`status ${delRes.failed[0].status}`;
								}
							} catch (cleanupErr) {
								cleanupError =
									cleanupErr instanceof Error
										? cleanupErr.message
										: String(cleanupErr);
							}
						}
						const baseError = `Destination parity verification failed for "${targetName}" (expected size=${bytes.byteLength} sha256=${computedSha256}, got size=${uploadedSize ?? "unknown"} sha256=${uploadedSha256 ?? "unknown"})`;
						results.push({
							source_id: fileId,
							destination_id: null,
							name: targetName,
							status: "failed",
							size: bytes.byteLength,
							sha256: computedSha256,
							exported: Boolean(exportSpec),
							...(exportSpec
								? { exported_mime_type: exportSpec.mimeType }
								: {}),
							cleaned_up: cleanedUp,
							error: cleanupError
								? `${baseError}; cleanup failed: ${cleanupError}`
								: baseError,
						});
						continue;
					}

					existingByNameLower.set(uploaded.name.toLowerCase(), uploaded);

					results.push({
						source_id: fileId,
						destination_id: uploaded.id,
						name: uploaded.name,
						status: "copied",
						size: bytes.byteLength,
						sha256: computedSha256,
						exported: Boolean(exportSpec),
						...(exportSpec ? { exported_mime_type: exportSpec.mimeType } : {}),
					});
				} catch (err) {
					results.push({
						source_id: fileId,
						destination_id: null,
						name: fileId,
						status: "failed",
						size: 0,
						sha256: null,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			return {
				domain,
				copied_count: results.filter((r) => r.status === "copied").length,
				skipped_count: results.filter((r) => r.status === "skipped_identical")
					.length,
				failed_count: results.filter((r) => r.status === "failed").length,
				results,
			};
		},
	});
}

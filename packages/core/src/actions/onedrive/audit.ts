import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { DrivePort } from "../../ports/drive.js";
import { isFolder, isGoogleDoc } from "../../ports/drive.js";
import type { OneDrivePort } from "../../ports/onedrive.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import {
	escapeDriveQueryLiteral,
	GOOGLE_WORKSPACE_OFFICE_EXPORT,
	type OnedriveGdrivePorts,
	resolveCrossCloudPorts,
	resolveExportedOfficeFileName,
} from "./transfer.js";

const DEFAULT_AUDIT_MAX_ITEMS = 1000;
const MAX_AUDIT_ITEMS = 5000;
const PAGE_SIZE = 200;

export const onedriveAuditVsGdriveInputSchema = z.object({
	onedrive_folder_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"OneDrive folder item ID to audit (defaults to 'root' when onedrive_path is omitted).",
		),
	onedrive_path: z
		.string()
		.min(1)
		.optional()
		.describe(
			"OneDrive folder path relative to root (for example '/Backup - Google Drive'). Ignored when onedrive_folder_id is provided.",
		),
	gdrive_folder_id: z
		.string()
		.min(1)
		.describe("Google Drive folder ID to compare against."),
	domain: z
		.enum(DOMAINS)
		.default("angus")
		.describe("Google Drive domain ('work' or 'angus'; default 'angus')."),
	recursive: z
		.boolean()
		.default(true)
		.describe(
			"Whether to recursively walk subfolders in both trees (default true).",
		),
	max_items: z
		.number()
		.int()
		.min(1)
		.max(MAX_AUDIT_ITEMS)
		.default(DEFAULT_AUDIT_MAX_ITEMS)
		.describe(
			`Maximum number of file items to walk per cloud provider (1..${MAX_AUDIT_ITEMS}, default ${DEFAULT_AUDIT_MAX_ITEMS}).`,
		),
});

export type OnedriveAuditVsGdriveInput = z.infer<
	typeof onedriveAuditVsGdriveInputSchema
>;

export interface AuditMatchedItem {
	relative_path: string;
	onedrive_item_id: string;
	gdrive_file_id: string;
	size: number;
	sha256Hash: string | null;
	match_kind: "exact" | "google_workspace_export";
}

export interface AuditOnlyInOnedriveItem {
	item_id: string;
	name: string;
	relative_path: string;
	size: number;
	sha256Hash: string | null;
}

export interface AuditOnlyInGdriveItem {
	file_id: string;
	name: string;
	relative_path: string;
	mimeType: string | null;
	size: number | null;
	sha256Checksum: string | null;
}

export interface AuditMismatchItem {
	relative_path: string;
	onedrive_item_id: string;
	gdrive_file_id: string;
	onedrive_size: number;
	gdrive_size: number | null;
	onedrive_sha256: string | null;
	gdrive_sha256: string | null;
}

export interface CounterCopyCandidate {
	item_id: string;
	name: string;
	relative_path: string;
	canonical_item_id: string;
	canonical_name: string;
	canonical_relative_path: string;
	counter: number;
	size: number;
	sha256Hash: string;
}

export interface OnedriveAuditVsGdriveOutput {
	domain: Domain;
	onedrive_root: string;
	gdrive_folder_id: string;
	recursive: boolean;
	truncated: boolean;
	matched: AuditMatchedItem[];
	only_in_onedrive: AuditOnlyInOnedriveItem[];
	only_in_gdrive: AuditOnlyInGdriveItem[];
	size_or_hash_mismatch: AuditMismatchItem[];
	counter_copy_candidates: CounterCopyCandidate[];
	counter_copy_item_ids: string[];
	summary: {
		matched_count: number;
		only_in_onedrive_count: number;
		only_in_gdrive_count: number;
		size_or_hash_mismatch_count: number;
		counter_copy_candidates_count: number;
		counter_copy_reclaimable_bytes: number;
	};
}

interface OneDriveWalkFile {
	item_id: string;
	name: string;
	relative_path: string;
	parent_path: string;
	size: number;
	sha256Hash: string | null;
}

interface GDriveWalkFile {
	file_id: string;
	name: string;
	relative_path: string;
	parent_path: string;
	mimeType: string | null;
	size: number | null;
	sha256Checksum: string | null;
	is_google_workspace_doc: boolean;
	exported_relative_path: string | null;
}

/**
 * Parses MultCloud-style counter-copy filenames such as `Report 1.docx` -> `{ canonicalName: "Report.docx", counter: 1 }`.
 */
export function parseCounterCopyFileName(
	name: string,
): { canonicalName: string; counter: number } | null {
	const withExt = /^(.+?)\s+(\d+)(\.[^.]+)$/.exec(name);
	if (withExt) {
		const stem = withExt[1];
		const counter = Number(withExt[2]);
		const ext = withExt[3];
		if (stem && Number.isInteger(counter) && counter >= 1) {
			return {
				canonicalName: `${stem}${ext}`,
				counter,
			};
		}
	}
	const withoutExt = /^([^.]+?)\s+(\d+)$/.exec(name);
	if (withoutExt) {
		const stem = withoutExt[1];
		const counter = Number(withoutExt[2]);
		if (stem && Number.isInteger(counter) && counter >= 1) {
			return {
				canonicalName: stem,
				counter,
			};
		}
	}
	return null;
}

async function walkOneDriveTree(params: {
	onedrive: OneDrivePort;
	folderId?: string;
	path?: string;
	recursive: boolean;
	maxItems: number;
}): Promise<{ files: OneDriveWalkFile[]; truncated: boolean }> {
	const files: OneDriveWalkFile[] = [];
	let truncated = false;

	const queue: Array<{
		folderId?: string;
		path?: string;
		relativePrefix: string;
	}> = [
		{
			folderId: params.folderId ?? (params.path ? undefined : "root"),
			path: params.folderId ? undefined : params.path,
			relativePrefix: "",
		},
	];

	while (queue.length > 0 && files.length < params.maxItems) {
		const current = queue.shift()!;
		let cursor: string | undefined;

		do {
			const page = await params.onedrive.listChildren({
				folderId: current.folderId,
				path: cursor ? undefined : current.path,
				pageSize: PAGE_SIZE,
				cursor,
			});

			for (const item of page.items ?? []) {
				const relPath = current.relativePrefix
					? `${current.relativePrefix}/${item.name}`
					: item.name;
				if (item.folder && !item.file) {
					if (params.recursive) {
						queue.push({
							folderId: item.id,
							relativePrefix: relPath,
						});
					}
					continue;
				}

				if (files.length >= params.maxItems) {
					truncated = true;
					break;
				}

				files.push({
					item_id: item.id,
					name: item.name,
					relative_path: relPath,
					parent_path: current.relativePrefix,
					size: item.size ?? 0,
					sha256Hash: item.file?.hashes?.sha256Hash
						? item.file.hashes.sha256Hash.toLowerCase()
						: null,
				});
			}

			if (files.length >= params.maxItems && page.nextCursor) {
				truncated = true;
				break;
			}
			cursor = page.nextCursor;
		} while (cursor && files.length < params.maxItems);
	}

	if (queue.length > 0 && files.length >= params.maxItems) {
		truncated = true;
	}

	return { files, truncated };
}

async function walkGDriveTree(params: {
	drive: DrivePort;
	domain: Domain;
	folderId: string;
	recursive: boolean;
	maxItems: number;
}): Promise<{ files: GDriveWalkFile[]; truncated: boolean }> {
	const files: GDriveWalkFile[] = [];
	let truncated = false;

	const queue: Array<{ folderId: string; relativePrefix: string }> = [
		{ folderId: params.folderId, relativePrefix: "" },
	];

	while (queue.length > 0 && files.length < params.maxItems) {
		const current = queue.shift()!;
		let pageToken: string | undefined;
		const q = `'${escapeDriveQueryLiteral(current.folderId)}' in parents and trashed = false`;

		do {
			const page = await params.drive.listFiles({
				domain: params.domain,
				q,
				pageSize: PAGE_SIZE,
				pageToken,
			});

			for (const gfile of page.files ?? []) {
				if (gfile.trashed) continue;
				const name = gfile.name ?? gfile.id ?? "";
				const relPath = current.relativePrefix
					? `${current.relativePrefix}/${name}`
					: name;

				if (isFolder(gfile.mimeType)) {
					if (params.recursive && gfile.id) {
						queue.push({
							folderId: gfile.id,
							relativePrefix: relPath,
						});
					}
					continue;
				}

				if (files.length >= params.maxItems) {
					truncated = true;
					break;
				}

				const exportSpec = gfile.mimeType
					? GOOGLE_WORKSPACE_OFFICE_EXPORT[gfile.mimeType]
					: undefined;
				const exportedName = exportSpec
					? resolveExportedOfficeFileName(name, exportSpec.extension)
					: null;
				const exportedRelPath = exportedName
					? current.relativePrefix
						? `${current.relativePrefix}/${exportedName}`
						: exportedName
					: null;

				files.push({
					file_id: gfile.id ?? "",
					name,
					relative_path: relPath,
					parent_path: current.relativePrefix,
					mimeType: gfile.mimeType ?? null,
					size:
						gfile.size !== undefined && gfile.size !== null
							? Number(gfile.size)
							: null,
					sha256Checksum: gfile.sha256Checksum
						? gfile.sha256Checksum.toLowerCase()
						: null,
					is_google_workspace_doc: isGoogleDoc(gfile.mimeType),
					exported_relative_path: exportedRelPath,
				});
			}

			if (files.length >= params.maxItems && page.nextPageToken) {
				truncated = true;
				break;
			}
			pageToken = page.nextPageToken ?? undefined;
		} while (pageToken && files.length < params.maxItems);
	}

	if (queue.length > 0 && files.length >= params.maxItems) {
		truncated = true;
	}

	return { files, truncated };
}

/**
 * Create the `onedrive_audit_vs_gdrive` action backed by `OneDrivePort` and `DrivePort`.
 */
export function createOnedriveAuditVsGdriveAction(
	portsOrOnedrive: OnedriveGdrivePorts | OneDrivePort,
	maybeDrive?: DrivePort,
): ActionDefinition<
	typeof onedriveAuditVsGdriveInputSchema,
	OnedriveAuditVsGdriveOutput
> {
	const { onedrive, drive } = resolveCrossCloudPorts(
		portsOrOnedrive,
		maybeDrive,
	);

	return defineAction({
		id: "onedrive_audit_vs_gdrive",
		name: "onedrive_audit_vs_gdrive",
		description:
			"Walk a personal OneDrive folder tree and a Google Drive folder tree, classifying files into matched, only_in_onedrive, only_in_gdrive, size_or_hash_mismatch, and counter_copy_candidates.",
		domain: "integrations",
		schema: onedriveAuditVsGdriveInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: OnedriveAuditVsGdriveInput,
			_context: ActionContext,
		): Promise<OnedriveAuditVsGdriveOutput> {
			const domain: Domain = input.domain ?? "angus";
			const recursive = input.recursive ?? true;
			const maxItems = input.max_items ?? DEFAULT_AUDIT_MAX_ITEMS;

			const [odWalk, gdWalk] = await Promise.all([
				walkOneDriveTree({
					onedrive,
					folderId: input.onedrive_folder_id,
					path: input.onedrive_path,
					recursive,
					maxItems,
				}),
				walkGDriveTree({
					drive,
					domain,
					folderId: input.gdrive_folder_id,
					recursive,
					maxItems,
				}),
			]);

			const odByRelPathLower = new Map<string, OneDriveWalkFile>();
			for (const odFile of odWalk.files) {
				const key = odFile.relative_path.toLowerCase();
				if (!odByRelPathLower.has(key)) {
					odByRelPathLower.set(key, odFile);
				}
			}

			const counterCopyCandidates: CounterCopyCandidate[] = [];
			const counterCopyIdSet = new Set<string>();

			for (const odFile of odWalk.files) {
				const parsed = parseCounterCopyFileName(odFile.name);
				if (!parsed || !odFile.sha256Hash) continue;

				const canonicalRelPath = odFile.parent_path
					? `${odFile.parent_path}/${parsed.canonicalName}`
					: parsed.canonicalName;
				const canonicalSibling = odByRelPathLower.get(
					canonicalRelPath.toLowerCase(),
				);
				if (
					canonicalSibling &&
					canonicalSibling.item_id !== odFile.item_id &&
					canonicalSibling.size === odFile.size &&
					canonicalSibling.sha256Hash === odFile.sha256Hash
				) {
					counterCopyCandidates.push({
						item_id: odFile.item_id,
						name: odFile.name,
						relative_path: odFile.relative_path,
						canonical_item_id: canonicalSibling.item_id,
						canonical_name: canonicalSibling.name,
						canonical_relative_path: canonicalSibling.relative_path,
						counter: parsed.counter,
						size: odFile.size,
						sha256Hash: odFile.sha256Hash,
					});
					counterCopyIdSet.add(odFile.item_id);
				}
			}

			const matched: AuditMatchedItem[] = [];
			const sizeOrHashMismatch: AuditMismatchItem[] = [];
			const onlyInOnedrive: AuditOnlyInOnedriveItem[] = [];
			const onlyInGdrive: AuditOnlyInGdriveItem[] = [];

			const pairedOnedriveIds = new Set<string>();
			const pairedGdriveIds = new Set<string>();

			for (const gdFile of gdWalk.files) {
				const directOd = odByRelPathLower.get(
					gdFile.relative_path.toLowerCase(),
				);
				const exportedOd =
					!directOd && gdFile.exported_relative_path
						? odByRelPathLower.get(gdFile.exported_relative_path.toLowerCase())
						: undefined;
				const odFile = directOd ?? exportedOd;

				if (!odFile) {
					onlyInGdrive.push({
						file_id: gdFile.file_id,
						name: gdFile.name,
						relative_path: gdFile.relative_path,
						mimeType: gdFile.mimeType,
						size: gdFile.size,
						sha256Checksum: gdFile.sha256Checksum,
					});
					continue;
				}

				pairedOnedriveIds.add(odFile.item_id);
				pairedGdriveIds.add(gdFile.file_id);

				if (gdFile.is_google_workspace_doc) {
					matched.push({
						relative_path: odFile.relative_path,
						onedrive_item_id: odFile.item_id,
						gdrive_file_id: gdFile.file_id,
						size: odFile.size,
						sha256Hash: odFile.sha256Hash,
						match_kind: "google_workspace_export",
					});
					continue;
				}

				const sizeMatches =
					gdFile.size === null || gdFile.size === odFile.size;
				const hashMatches =
					!gdFile.sha256Checksum ||
					!odFile.sha256Hash ||
					gdFile.sha256Checksum === odFile.sha256Hash;

				if (sizeMatches && hashMatches) {
					matched.push({
						relative_path: odFile.relative_path,
						onedrive_item_id: odFile.item_id,
						gdrive_file_id: gdFile.file_id,
						size: odFile.size,
						sha256Hash: odFile.sha256Hash ?? gdFile.sha256Checksum,
						match_kind: "exact",
					});
				} else {
					sizeOrHashMismatch.push({
						relative_path: odFile.relative_path,
						onedrive_item_id: odFile.item_id,
						gdrive_file_id: gdFile.file_id,
						onedrive_size: odFile.size,
						gdrive_size: gdFile.size,
						onedrive_sha256: odFile.sha256Hash,
						gdrive_sha256: gdFile.sha256Checksum,
					});
				}
			}

			for (const odFile of odWalk.files) {
				if (pairedOnedriveIds.has(odFile.item_id)) continue;
				if (counterCopyIdSet.has(odFile.item_id)) continue;

				onlyInOnedrive.push({
					item_id: odFile.item_id,
					name: odFile.name,
					relative_path: odFile.relative_path,
					size: odFile.size,
					sha256Hash: odFile.sha256Hash,
				});
			}

			const counterCopyReclaimableBytes = counterCopyCandidates.reduce(
				(sum, item) => sum + item.size,
				0,
			);

			return {
				domain,
				onedrive_root:
					input.onedrive_folder_id ?? input.onedrive_path ?? "root",
				gdrive_folder_id: input.gdrive_folder_id,
				recursive,
				truncated: odWalk.truncated || gdWalk.truncated,
				matched,
				only_in_onedrive: onlyInOnedrive,
				only_in_gdrive: onlyInGdrive,
				size_or_hash_mismatch: sizeOrHashMismatch,
				counter_copy_candidates: counterCopyCandidates,
				counter_copy_item_ids: counterCopyCandidates.map((c) => c.item_id),
				summary: {
					matched_count: matched.length,
					only_in_onedrive_count: onlyInOnedrive.length,
					only_in_gdrive_count: onlyInGdrive.length,
					size_or_hash_mismatch_count: sizeOrHashMismatch.length,
					counter_copy_candidates_count: counterCopyCandidates.length,
					counter_copy_reclaimable_bytes: counterCopyReclaimableBytes,
				},
			};
		},
	});
}

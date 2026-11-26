import { z } from "zod";
import { ARTIFACT_SURFACES, slugify } from "../../domain/artifacts.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain, type Domain } from "../../domain/domains.js";
import { originationFor } from "../../domain/ingest/discoverPointers.js";
import { DRIVE_CONNECTOR_BY_ACCOUNT } from "../../domain/ingest/selection.js";
import type { ArtifactRepository } from "../../ports/artifacts.js";
import { isFolder, type DrivePort } from "../../ports/drive.js";
import type { StoragePort } from "../../ports/storage.js";
import {
	DEFAULT_GOOGLE_ACCOUNT,
	googleAccountInput,
	type GoogleAccount,
} from "../appsscript/account.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { FOLDER_PATH_FIELDS, IMPORT_FILE_FIELDS } from "./importFile.js";

export interface DriveArtifactLookup {
	id: string;
	title: string | null;
	storage_bucket: string | null;
	storage_path: string | null;
	storage_url?: string | null;
	file_size?: number | null;
	file_type?: string | null;
	processing_status: string | null;
	plain_text?: string | null;
	source_url: string | null;
	source_parent_folder_ids: string[] | null;
	source_parent_folder_path: string | null;
}

export interface IngestDrivePorts {
	drive: Pick<DrivePort, "getFile" | "downloadFile">;
	artifacts: Pick<ArtifactRepository, "insert">;
	storage: Pick<StoragePort, "upload" | "remove" | "publicUrl">;
	findArtifactByDriveFileId?: (fileId: string) => Promise<DriveArtifactLookup | null>;
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

export const ingestDriveInput = {
	file_id: z.string().min(1).describe("Drive file id to ingest into the knowledge store."),
	title: z
		.string()
		.optional()
		.describe("Optional human-friendly artifact title. Defaults to the Drive file name."),
	tags: z.array(z.string()).optional().describe("Optional tags for the artifact."),
	account: googleAccountInput,
	domain: optionalDomainInput,
};

export const ingestDriveSchema = z.object(ingestDriveInput);
export type IngestDriveInput = z.infer<typeof ingestDriveSchema>;

export interface IngestDriveOutput {
	reused: boolean;
	artifact_id: string;
	artifact_title: string;
	drive_file_id: string;
	drive_web_view_link: string;
	drive_parent_folder_ids: string[];
	drive_parent_folder_path: string | null;
	storage_bucket: string;
	storage_path: string;
	processing_status: string;
	textual: boolean;
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

export function formatIngestDriveMcp(out: IngestDriveOutput): string {
	if (out.reused) {
		return [
			`Drive file ${out.drive_file_id} already ingested as artifact ${out.artifact_id}.`,
			`Title: ${out.artifact_title}`,
			`Source URL: ${out.drive_web_view_link}`,
			`Parent folder ids: ${out.drive_parent_folder_ids.length ? out.drive_parent_folder_ids.join(", ") : "(none)"}`,
			`Parent folder path: ${out.drive_parent_folder_path ?? "(root or unknown)"}`,
			`Stored at: ${out.storage_bucket}/${out.storage_path}`,
			`Status: ${out.processing_status}`,
			"Existing artifact reused rather than re-capturing.",
		].join("\n");
	}

	const next = out.textual
		? "Text stored and searchable now. If you extracted entities, call artifact_sync_entities next."
		: "Binary stored \u2014 call artifact_extract_text with this artifact id to make it searchable, then artifact_sync_entities if needed.";

	return [
		`Ingested Drive file ${out.drive_file_id} as artifact ${out.artifact_id}.`,
		`Title: ${out.artifact_title}`,
		`Source URL: ${out.drive_web_view_link}`,
		`Parent folder ids: ${out.drive_parent_folder_ids.length ? out.drive_parent_folder_ids.join(", ") : "(none)"}`,
		`Parent folder path: ${out.drive_parent_folder_path ?? "(root or unknown)"}`,
		`Stored at: ${out.storage_bucket}/${out.storage_path}`,
		`Status: ${out.processing_status}`,
		next,
	].join("\n");
}

export function createIngestDriveAction(
	ports: IngestDrivePorts,
): ActionDefinition<typeof ingestDriveSchema, IngestDriveOutput> {
	return defineAction({
		id: "ingest_drive",
		domain: "integrations",
		description:
			"Ingest a Google Drive file into the knowledge store without taking any Drive-side cleanup action. Downloads/exports the file, persists the artifact with Drive provenance, and returns the routing context so the agent can extract entities and decide keep/move/archive/delete afterward.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: ingestDriveSchema,
		formatMcp: formatIngestDriveMcp,
		async run(args, ctx): Promise<IngestDriveOutput> {
			if (!ports.findArtifactByDriveFileId) {
				throw new Error("Drive ingest findArtifactByDriveFileId port is not wired.");
			}

			const existing = await ports.findArtifactByDriveFileId(args.file_id);
			if (existing) {
				return {
					reused: true,
					artifact_id: existing.id,
					artifact_title: existing.title ?? "(untitled)",
					drive_file_id: args.file_id,
					drive_web_view_link:
						existing.source_url ?? `https://drive.google.com/file/d/${args.file_id}`,
					drive_parent_folder_ids: existing.source_parent_folder_ids ?? [],
					drive_parent_folder_path: existing.source_parent_folder_path ?? null,
					storage_bucket: existing.storage_bucket ?? "",
					storage_path: existing.storage_path ?? "",
					processing_status: existing.processing_status ?? "completed",
					textual: Boolean(existing.plain_text),
				};
			}

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

			return {
				reused: false,
				artifact_id: inserted.id,
				artifact_title: resolvedTitle,
				drive_file_id: driveFileId,
				drive_web_view_link: sourceUrl,
				drive_parent_folder_ids: parents,
				drive_parent_folder_path: parentPath,
				storage_bucket: bucket,
				storage_path: storagePath,
				processing_status: processingStatus,
				textual,
			};
		},
	});
}

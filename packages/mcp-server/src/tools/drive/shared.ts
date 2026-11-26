import { randomUUID } from "node:crypto";
import { resolveGoogleAccount } from "../googleAccountInput.js";
import { supabase } from "../../supabase.js";
import { env } from "../../env.js";
import { getCurrentUserId } from "../../identity.js";
import { buildStorageUrl, slugify } from "../../kms/artifacts.js";
import { downloadFileBytes, getDrive, isFolder } from "../../google/drive.js";
import {
	DEFAULT_GOOGLE_ACCOUNT,
	type GoogleAccount,
} from "../../google/accounts.js";
import { ARTIFACT_SURFACES } from "@ahkms/shared";
import { originationFor } from "../../vocab.js";
import { DRIVE_CONNECTOR_BY_ACCOUNT } from "@ahkms/core";

export function isTextual(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml"
	);
}

export function deriveExtension(name: string, exported: string | null): string | null {
	if (exported) return exported;
	const dot = name.lastIndexOf(".");
	if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
	return null;
}

async function loadFolderPath(
	folderId: string,
	account: GoogleAccount,
): Promise<{ ids: string[]; path: string | null }> {
	const drive = await getDrive(account);
	const ids: string[] = [];
	const names: string[] = [];
	let currentId = folderId;

	for (let depth = 0; depth < 20; depth += 1) {
		const meta = await drive.files.get({
			fileId: currentId,
			fields: "id, name, parents, mimeType",
			supportsAllDrives: true,
		});
		if (!isFolder(meta.data.mimeType)) break;

		const id = meta.data.id ?? currentId;
		ids.unshift(id);
		names.unshift(meta.data.name ?? id);

		const parentId = meta.data.parents?.[0];
		if (!parentId || parentId === "root" || parentId === currentId) break;
		currentId = parentId;
	}

	return { ids, path: names.length ? names.join(" / ") : null };
}

export type ImportedDriveArtifact = {
	artifact_id: string;
	artifact_title: string;
	storage_bucket: string;
	storage_path: string;
	storage_url: string;
	file_size: number;
	mime_type: string;
	textual: boolean;
	processing_status: string;
	plain_text: string | null;
	drive_file_id: string;
	drive_file_name: string;
	drive_web_view_link: string;
	drive_parent_folder_ids: string[];
	drive_parent_folder_path: string | null;
};

export async function importDriveFileArtifact(args: {
	file_id: string;
	title?: string;
	tags?: string[];
	/** Which Google account owns the file. Defaults to personal (issue #338). */
	account?: GoogleAccount;
	/**
	 * Optional content-subtype flag (e.g. 'meeting-note'), same open vocab as
	 * capture's own `content_subtype`. This is the calling ADAPTER declaring what
	 * pipeline produced the row — an envelope fact, not a reading of the file's
	 * content — so it is safe to pass without violating capture's "never inferred
	 * from content" rule (#873).
	 */
	content_subtype?: string;
}): Promise<ImportedDriveArtifact> {
	const account = resolveGoogleAccount(args) ?? DEFAULT_GOOGLE_ACCOUNT;
	const drive = await getDrive(account);
	const meta = await drive.files.get({
		fileId: args.file_id,
		// `createdTime` is here for ADR-088 / #571: it is the file's ORIGINATION, and
		// until now this path fetched it not at all and stamped only `captured_at`,
		// so a 2016 document imported today read as a 2016-authored thing that
		// happened today. One extra field on a request already being made.
		fields: "id, name, mimeType, webViewLink, parents, createdTime, modifiedTime",
		supportsAllDrives: true,
	});
	const driveName = meta.data.name ?? "drive-file";
	const driveMime = meta.data.mimeType ?? "";
	const driveFileId = meta.data.id ?? args.file_id;
	const parents = meta.data.parents ?? [];
	const parentPath = parents[0] ? (await loadFolderPath(parents[0], account)).path : null;

	if (isFolder(driveMime)) {
		throw new Error(`${args.file_id} is a folder — import individual files instead.`);
	}

	const { buffer, mimeType, extension: exportedExt } = await downloadFileBytes(args.file_id, driveMime, account);
	const id = randomUUID();
	const ext = deriveExtension(driveName, exportedExt);
	const storagePath = `drive-imports/${getCurrentUserId()}/${id}${ext ? `.${ext}` : ""}`;
	const artifactTitle = args.title ?? driveName;
	const filename = `${slugify(artifactTitle)}-${id.slice(0, 8)}${ext ? `.${ext}` : ""}`;
	const sourceUrl = meta.data.webViewLink ?? `https://drive.google.com/file/d/${args.file_id}`;

	const { error: uploadError } = await supabase.storage
		.from(env.storageBucket)
		.upload(storagePath, buffer, { contentType: mimeType, upsert: false });
	if (uploadError) {
		throw new Error(`Storage upload failed: ${uploadError.message}`);
	}

	const originatedAt = originationFor(DRIVE_CONNECTOR_BY_ACCOUNT[account], {
		source_created_at: meta.data.createdTime,
		source_modified_at: meta.data.modifiedTime,
	});

	const textual = isTextual(mimeType);
	const plainText = textual ? buffer.toString("utf-8") : null;

	const { data, error } = await supabase
		.from("artifacts")
		.insert({
			id,
			user_id: getCurrentUserId(),
			storage_bucket: env.storageBucket,
			storage_path: storagePath,
			storage_url: buildStorageUrl(env.storageBucket, storagePath),
			filename,
			original_file_name: driveName,
			file_type: mimeType,
			content_type: mimeType,
			file_extension: ext,
			file_size: buffer.length,
			artifact_type: "original",
			captured_at: new Date().toISOString(),
			// Valid time (ADR-088 / #571). drive_import writes no `processing_metadata.
			// discovery` block — it is the owner asking for one named file, not a sweep —
			// so before this column there was nowhere for the file's own date to go and it
			// was simply dropped. Routed through the SAME per-source table the discover
			// cadence uses (ORIGINATION_FIELD_BY_CONNECTOR), keyed by this account's Drive
			// connector name, so the two Drive ingest paths can never disagree about which
			// timestamp means "from". Omitted, not nulled, when Drive served nothing.
			...(originatedAt ? { originated_at: originatedAt } : {}),
			source: sourceUrl,
			source_url: sourceUrl,
			source_drive_file_id: driveFileId,
			source_parent_folder_ids: parents,
			source_parent_folder_path: parentPath,
			// `google_drive`, with an UNDERSCORE (#1208). This was `google-drive`, and
			// the hyphen fails artifacts_source_channel_check (`^[a-z_]+$`, remote
			// schema), so every drive_import_file / drive_ingest insert was rejected
			// and the path never wrote a row (migration 091's header counts zero).
			// There is therefore no historical `google-drive` row for a reader to miss.
			// `google_drive` is the spelling the rest of the code already uses for Drive
			// (ENRICHABLE_CONNECTORS, ORIGINATION_FIELD_BY_CONNECTOR), and it stays
			// distinct from the discover channels, which are all `discovered_*`.
			// sourceChannelCheck.test.ts pins every literal channel to the CHECK.
			source_channel: "google_drive",
			// Provenance (ADR-026; ADR-046 §2/§3, #584). A field-copy of which TOOL
			// this row came through — an envelope fact, nothing read from the file.
			// Deliberately NOT `source_channel`: `google_drive` names the SYSTEM the
			// bytes came from, and the discover path already claims that space with
			// `discovered_gdrive`. Pooling the two would make "the owner asked for
			// this one file" and "a bulk account inventory" one role key, which is
			// the distinction #567's flood turned on.
			surface: ARTIFACT_SURFACES.driveImport,
			lifecycle_stage: "uploaded",
			processing_status: textual ? "completed" : "pending",
			title: artifactTitle,
			plain_text: plainText,
			tags: args.tags ?? [],
			content_subtype: args.content_subtype ?? null,
		})
		.select("id, title, storage_path, storage_url, file_size, plain_text, processing_status")
		.single();

	if (error) {
		await supabase.storage.from(env.storageBucket).remove([storagePath]);
		throw new Error(`Insert failed: ${error.message}`);
	}

	return {
		artifact_id: data.id,
		artifact_title: data.title ?? artifactTitle,
		storage_bucket: env.storageBucket,
		storage_path: data.storage_path,
		storage_url: data.storage_url,
		file_size: data.file_size ?? buffer.length,
		mime_type: mimeType,
		textual,
		processing_status: data.processing_status ?? (textual ? "completed" : "pending"),
		plain_text: data.plain_text ?? plainText,
		drive_file_id: driveFileId,
		drive_file_name: driveName,
		drive_web_view_link: sourceUrl,
		drive_parent_folder_ids: parents,
		drive_parent_folder_path: parentPath,
	};
}

/**
 * Matches rows that are NOT discover pointers, for findArtifactByDriveFileId (#1228, #1368).
 * Since #1228 the Drive discover sweep fills `source_drive_file_id` on its
 * pointers too, so without this a doc the sweep had already inventoried would be
 * "found" as its bytes-less `discovered_gdrive` pointer and never imported as an
 * ingested atom. The two are different atoms by design (ADR-069: the same
 * file on two surfaces stays two rows). The `is.null` arm keeps rows with no
 * channel at all, which `not.like` alone would drop (NULL LIKE x is NULL).
 */
export const NOT_A_DISCOVER_POINTER_FILTER =
	"source_channel.is.null,source_channel.not.like.discovered_*";

export type DriveArtifactLookup = {
	id: string;
	title: string | null;
	storage_bucket: string | null;
	storage_path: string | null;
	storage_url: string | null;
	file_size: number | null;
	file_type: string | null;
	processing_status: string | null;
	plain_text: string | null;
	source_url: string | null;
	source_parent_folder_ids: string[] | null;
	source_parent_folder_path: string | null;
};

export async function findArtifactByDriveFileId(
	fileId: string,
): Promise<DriveArtifactLookup | null> {
	const { data, error } = await supabase
		.from("artifacts")
		.select(
			"id, title, storage_bucket, storage_path, storage_url, file_size, file_type, processing_status, plain_text, source_url, source_parent_folder_ids, source_parent_folder_path",
		)
		.eq("user_id", getCurrentUserId())
		.eq("source_drive_file_id", fileId)
		.or(NOT_A_DISCOVER_POINTER_FILTER)
		.limit(1)
		.maybeSingle();
	if (error) throw new Error(`Artifact lookup by Drive file id failed: ${error.message}`);
	return data;
}


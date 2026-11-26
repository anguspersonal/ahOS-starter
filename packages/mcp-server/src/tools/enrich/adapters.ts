import { getDrive, downloadFileBytes } from "../../google/drive.js";
import {
	DRIVE_CONNECTOR_ACCOUNT,
	ENRICHABLE_CONNECTORS,
	URL_CONNECTORS,
	isDriveConnector,
} from "@ahkms/core";
import { createOneDriveAdapter } from "@ahkms/core/adapters";
import { DEFAULT_GOOGLE_ACCOUNT } from "../../google/accounts.js";
import { getCredential } from "../../credentials.js";
import { env } from "../../env.js";
import { urlAdapter } from "./urlAdapter.js";

// Connector read adapters for ingest_enrich_next (ADR-016, Slice 2, #52).
//
// `ingest_discover` (Slice 1) is fully connector-agnostic: the agent lists items from an
// already-wired connector MCP server and hands the batch to the write side. Enrichment
// is the opposite: it must *fetch* the content, which is connector-specific. We keep
// that behind a small read-adapter registry keyed on the `discovery.connector` value
// recorded on each pointer.
//
// Only connectors with a server-side read client can be enriched here. Today that is
// Google Drive (the mcp-server holds a Drive OAuth client) and URLs. Notion is write-only and
// Gmail is absent: those pointers are simply not selected for enrichment until a
// server-side read client exists. (Notion read adapter is explicitly deferred per #1229 /
// ADR091 pending a dedicated recursive block-tree walker), so they stay queued rather than failing.

import type {
	PointerRef,
	FetchedContent,
	ReadAdapter,
	EnrichSourcePort,
} from "@ahkms/core";

export type { PointerRef, FetchedContent, ReadAdapter, EnrichSourcePort };

// --- Google Drive adapter ---------------------------------------------------
// Reuses the same download/export path as drive_import_file. The pointer's
// externalId is the Drive file id; md5Checksum is the change-signal for binary
// files, falling back to modifiedTime for Google-native docs (which have none).
//
// This contentHash source must stay aligned with what `ingest_discover` records for the
// same connector, or re-discovery diffing misfires. The scheduled discover cadence
// (#53, runDriveDiscoverCadence) uses the same `md5Checksum ?? modifiedTime`, so
// they line up; a hand-rolled agent-driven `ingest_discover` for gdrive must do the same.
const driveAdapter: ReadAdapter = {
	connector: "gdrive",
	async fetch(ref: PointerRef): Promise<FetchedContent> {
		// Read the pointer back with the account it was DISCOVERED under, not with
		// whichever account happens to be the default (#857). A pointer swept from
		// the Work account is invisible to a personal client, and Drive answers
		// that as a 404 on the file id rather than as a permissions error, so the
		// wrong account here reads as "the file is gone".
		const account = DRIVE_CONNECTOR_ACCOUNT[ref.connector] ?? DEFAULT_GOOGLE_ACCOUNT;
		const drive = await getDrive(account);
		const meta = await drive.files.get({
			fileId: ref.externalId,
			fields: "id, name, mimeType, md5Checksum, modifiedTime",
			supportsAllDrives: true,
		});
		const driveMime = meta.data.mimeType ?? "";
		const { buffer, mimeType, extension } = await downloadFileBytes(
			ref.externalId,
			driveMime,
			account,
		);
		return {
			buffer,
			mimeType,
			extension,
			contentHash: meta.data.md5Checksum ?? meta.data.modifiedTime ?? null,
			sourceName: meta.data.name ?? null,
			text: null,
		};
	},
};

function extensionFromName(name: string | null | undefined, mimeType: string): string {
	const rawName = (name ?? "").trim();
	const dot = rawName.lastIndexOf(".");
	if (dot > 0 && dot < rawName.length - 1) {
		return rawName.slice(dot + 1).toLowerCase();
	}
	if (mimeType === "application/pdf") return "pdf";
	if (mimeType === "text/markdown") return "md";
	if (mimeType === "text/csv") return "csv";
	if (mimeType === "application/json") return "json";
	return "txt";
}

// --- OneDrive adapter -------------------------------------------------------
const onedriveAdapter: ReadAdapter = {
	connector: "onedrive",
	async fetch(ref: PointerRef): Promise<FetchedContent> {
		const client = createOneDriveAdapter({
			clientId: env.microsoftClientId ?? "",
			clientSecret: env.microsoftClientSecret,
			refreshToken: () => getCredential("microsoft_personal"),
		});
		const { item, bytes, mimeType } = await client.downloadItemBytes({
			itemId: ref.externalId,
		});
		return {
			buffer: Buffer.from(bytes),
			mimeType,
			extension: extensionFromName(item.name, mimeType),
			contentHash:
				item.file?.hashes?.sha256Hash ??
				item.file?.hashes?.quickXorHash ??
				item.eTag ??
				item.lastModifiedDateTime ??
				null,
			sourceName: item.name ?? null,
			text: null,
		};
	},
};

// Registry. Drive, OneDrive, and URL adapters are reachable under their connector spellings.
const adapters = new Map<string, ReadAdapter>();
for (const alias of ENRICHABLE_CONNECTORS) {
	if (isDriveConnector(alias)) {
		adapters.set(alias, driveAdapter);
	}
}
adapters.set("onedrive", onedriveAdapter);
for (const alias of URL_CONNECTORS) {
	adapters.set(alias, urlAdapter);
}

export function getReadAdapter(connector: string): ReadAdapter | undefined {
	return adapters.get(connector);
}

/** Connector keys we can actually fetch content for. */
export function supportedConnectors(): string[] {
	return [...adapters.keys()];
}

export const enrichSourcePort: EnrichSourcePort = {
	getReadAdapter,
	supportedConnectors,
};

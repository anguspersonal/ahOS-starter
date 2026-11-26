/**
 * Facts about a discovered pointer that an agent needs to act on a document without
 * a second call: its link, connector, external id, owner, content hash (with what
 * kind of hash it really is), mime type, size and source-modified time. Shared by
 * artifact_get (#1214), document_resolve (#1230) and document_duplicates (#1217),
 * so the three read the discovery envelope the same way.
 *
 * The envelope is `processing_metadata.discovery`, written by discover.ts's
 * `discoveryMetadata` and refreshed by enrichNext.ts. `mime_type`, `size` and
 * `owner_email` are read when present (the Drive envelope widening, #1228) and
 * simply absent before it.
 */

/** A real md5: the only content hash that is evidence of identical bytes. */
export const MD5_PATTERN = /^[0-9a-f]{32}$/;

export type Discovery = {
	connector?: string | null;
	external_id?: string | null;
	url?: string | null;
	owner?: string | null;
	owner_email?: string | null;
	source_created_at?: string | null;
	source_modified_at?: string | null;
	content_hash?: string | null;
	mime_type?: string | null;
	size?: string | number | null;
};

/** The discovery envelope off a row's processing_metadata, or null when it has none. */
export function discoveryOf(processingMetadata: unknown): Discovery | null {
	if (!processingMetadata || typeof processingMetadata !== "object") return null;
	const disc = (processingMetadata as { discovery?: unknown }).discovery;
	if (!disc || typeof disc !== "object" || Array.isArray(disc)) return null;
	return disc as Discovery;
}

/** Non-empty string or null: the envelope is jsonb, so a field can hold anything. */
export function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * What a stored content_hash actually is. Drive writes `md5Checksum ?? modifiedTime`
 * and Notion `last_edited_time` under the same key (driveDiscoverCadence.ts,
 * notionDiscoverCadence.ts), so only a 32-hex value is a content hash; anything else
 * is a timestamp, and two rows sharing it are NOT the same document.
 */
export function contentHashKind(hash: unknown): "md5" | "modified_time" | null {
	const h = str(hash);
	if (!h) return null;
	return MD5_PATTERN.test(h) ? "md5" : "modified_time";
}

/** "Name <email>", either alone, or null. */
export function ownerLabel(disc: Discovery | null): string | null {
	const name = str(disc?.owner);
	const email = str(disc?.owner_email);
	if (name && email) return `${name} <${email}>`;
	return name ?? email;
}

/** "837,932 bytes" from a number or the numeric string Drive returns; raw text otherwise. */
export function formatSize(size: unknown): string | null {
	if (size === null || size === undefined || size === "") return null;
	const n = typeof size === "number" ? size : Number(size);
	if (!Number.isFinite(n)) return String(size);
	return `${n.toLocaleString("en-US")} bytes`;
}

/** A discovered pointer with no source URL gets this logical locator as storage_url. */
const LOCATOR_PREFIX = "discovered://";

/**
 * The link to open a document where it lives. The discovery envelope's `url` first:
 * enrichment re-points `storage_url` at the stored blob, so for an enriched pointer
 * storage_url is no longer the source. Then an external pointer's storage_url
 * (unless it is only the `discovered://` locator), then `source_url`.
 */
export function documentLink(row: {
	storage_bucket?: string | null;
	storage_url?: string | null;
	source_url?: string | null;
	processing_metadata?: unknown;
}): string | null {
	const disc = discoveryOf(row.processing_metadata);
	const fromDisc = str(disc?.url);
	if (fromDisc) return fromDisc;
	const storageUrl = str(row.storage_url);
	if (row.storage_bucket === "external" && storageUrl && !storageUrl.startsWith(LOCATOR_PREFIX)) {
		return storageUrl;
	}
	return str(row.source_url);
}

/**
 * The lines artifact_get prints for an external pointer (#1214). Link, connector,
 * external id, owner, content hash and modified-at-source always appear, saying so
 * when a value is missing; mime type and size only when the envelope has them.
 */
export function pointerDetailLines(row: {
	storage_url: string;
	source: string | null;
	source_channel: string | null;
	file_type?: string | null;
	file_size?: number | null;
	processing_metadata?: unknown;
}): string[] {
	const disc = discoveryOf(row.processing_metadata);
	const link = row.storage_url.startsWith(LOCATOR_PREFIX)
		? `(none recorded; locator ${row.storage_url})`
		: row.storage_url;
	const channel = row.source_channel ?? "";
	const connector =
		str(disc?.connector) ?? (channel.startsWith("discovered_") ? channel.slice("discovered_".length) : null);
	const hash = str(disc?.content_hash);
	const mime = str(disc?.mime_type) ?? str(row.file_type);
	const size = formatSize(disc?.size ?? row.file_size ?? null);
	return [
		`Link: ${link}`,
		`Connector: ${connector ?? "(unknown)"}`,
		`External id: ${str(disc?.external_id) ?? row.source ?? "(unknown)"}`,
		`Owner: ${ownerLabel(disc) ?? "(unknown)"}`,
		`Content hash: ${hash ? `${hash} (${contentHashKind(hash)})` : "(none)"}`,
		...(mime ? [`Mime type: ${mime}`] : []),
		...(size ? [`Size: ${size}`] : []),
		`Modified at source: ${str(disc?.source_modified_at) ?? "(unknown)"}`,
	];
}

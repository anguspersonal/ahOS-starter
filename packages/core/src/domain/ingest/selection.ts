// Pure selection helpers for ingest_enrich_next (ADR-016, Slice 2, #52).
//
// Deliberately free of supabase / env / connector-client imports, so the connector
// resolution and channel-filter logic is unit-testable without live credentials.
// (The rest of ingest_enrich_next needs a real Supabase + Drive client to exercise; this
// is the part worth covering in CI.)

export const DISCOVERED_PREFIX = "discovered_";

// The connectors ingest_enrich_next has a server-side read adapter for. Kept in this
// dependency-free module (not adapters.ts, which pulls in the Drive client) so the
// discover write-side can ask "can this connector ever be enriched?" without
// importing googleapis. adapters.ts registers exactly these keys.
export const URL_CONNECTORS = [
	"url",
	"web",
	"link",
	"discovered_url",
] as const;

export const ENRICHABLE_CONNECTORS = [
	"gdrive",
	"google_drive",
	"drive",
	"gdrive_work",
	"onedrive",
] as const;

/** Whether a connector name corresponds to a URL web fetch. */
export function isUrlConnector(connector: string): boolean {
	return (URL_CONNECTORS as readonly string[]).includes(connector as any);
}

/**
 * Which Google account a Drive connector name reads as (#857, #338).
 *
 * The account is carried in the CONNECTOR NAME rather than as a separate column,
 * because `ingest_discover` already derives `source_channel` as `discovered_<connector>`
 * and the pointer records its connector in `processing_metadata.discovery`. So a
 * name is the one place that already reaches both the write side and the read
 * side, with no schema change and no second field to keep in step.
 *
 * The personal account keeps the bare `gdrive` spelling, and that asymmetry is
 * deliberate: `source_channel` is written onto every pointer row and is the key
 * re-discovery matches on. Renaming personal's channel to `gdrive_personal`
 * would orphan every pointer already discovered: they would stop matching, be
 * re-inserted as new, and the old rows would sit unreachable forever. A second
 * account is additive; a rename is not.
 *
 * Anything absent from this map is a Drive connector spelling that predates the
 * account dimension, so it reads as personal, which is what those pointers were
 * discovered with.
 */
export const DRIVE_CONNECTOR_ACCOUNT: Readonly<Record<string, "personal" | "work">> = {
	gdrive: "personal",
	google_drive: "personal",
	drive: "personal",
	gdrive_work: "work",
};

/**
 * The connector name a scheduled sweep of this account writes pointers under.
 * Inverse of the map above for the canonical spellings only: the aliases exist so
 * an agent-driven `ingest_discover` call is forgiving about spelling, never so a sweep
 * can pick one.
 */
export const DRIVE_CONNECTOR_BY_ACCOUNT: Readonly<Record<"personal" | "work", string>> = {
	personal: "gdrive",
	work: "gdrive_work",
};

/** Whether ingest_enrich_next has a server-side reader for this connector's pointers. */
export function isEnrichableConnector(connector: string): boolean {
	return (
		(ENRICHABLE_CONNECTORS as readonly string[]).includes(connector) ||
		isUrlConnector(connector)
	);
}

/** Whether a connector name is one of the Drive spellings (any account). */
export function isDriveConnector(connector: string): boolean {
	return Object.prototype.hasOwnProperty.call(DRIVE_CONNECTOR_ACCOUNT, connector);
}

/**
 * Drive's mimeType for a folder (#1228). Duplicated from google/drive.ts's
 * `isFolder` on purpose: this module stays free of the googleapis import graph so
 * the discover write side can ask the question without loading a Drive client.
 */
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Whether ONE pointer can ever be enriched: its connector has a reader AND it is
 * not a folder. A folder has no bytes to download, so queueing it only burns a
 * unit of the daily enrich budget on a guaranteed failure (pointer 3c51b40b
 * 'CV Curriculum vitae' sat 'pending' for weeks as exactly that). The mimeType is
 * the Drive envelope field-copy discover now records (ADR-046 §2), so this reads
 * a fact the source served, not the content.
 */
export function isEnrichablePointer(connector: string, mimeType: string | null | undefined): boolean {
	return isEnrichableConnector(connector) && mimeType !== DRIVE_FOLDER_MIME;
}

/**
 * PostgREST `or=` filter that keeps every discovered pointer EXCEPT a recorded
 * Drive folder, for the enrich selection and its backlog count (#1228). The
 * `is.null` arm is load-bearing: pointers discovered before the envelope carried
 * `mime_type` (and every non-Drive pointer) have no value there, and a bare
 * `neq` would drop them, because NULL <> x is NULL, not true, in SQL.
 */
export const NOT_A_FOLDER_FILTER =
	"processing_metadata->discovery->>mime_type.is.null," +
	`processing_metadata->discovery->>mime_type.neq.${DRIVE_FOLDER_MIME}`;

/** Minimal shape of a discovered pointer row needed to resolve its connector. */
export interface DiscoveredPointer {
	source_channel: string | null;
	processing_metadata: { discovery?: Record<string, unknown> } | null;
}

// The connector to fetch a pointer with: prefer the value recorded at discovery
// time, fall back to parsing the 'discovered_<connector>' channel. Returns null
// when neither yields a connector.
export function connectorOf(row: DiscoveredPointer): string | null {
	const fromMeta = row.processing_metadata?.discovery?.connector;
	if (typeof fromMeta === "string" && fromMeta) return fromMeta;
	const channel = row.source_channel ?? "";
	return channel.startsWith(DISCOVERED_PREFIX)
		? channel.slice(DISCOVERED_PREFIX.length)
		: null;
}

// Build the source_channel filter for selection. A specific connector targets its
// single channel (even if unsupported: the caller decides what to do with that);
// otherwise scope to every connector we can actually read.
export function channelsForConnector(
	connector: string | undefined,
	supported: string[],
): string[] {
	if (connector) {
		return isUrlConnector(connector)
			? [`${DISCOVERED_PREFIX}${connector}`, "discovered_url", "url", "web", "link"]
			: [`${DISCOVERED_PREFIX}${connector}`];
	}
	return supported.map((c) => `${DISCOVERED_PREFIX}${c}`);
}

/**
 * Whether a buffer begins with the standard PDF magic header (%PDF-).
 *
 * Used to catch misdeclared files (e.g. PDFs served or discovered with
 * mimeType: application/json or text/plain) before storing raw PDF bytes
 * into artifacts.plain_text (#1229).
 */
export function isPdfBuffer(buffer: Buffer): boolean {
	return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

/**
 * Whether a buffer or decoded text holds undecoded binary bytes.
 *
 * Returns true if the buffer has a PDF magic header, contains null bytes in its
 * initial chunk, or if the text starts with a raw PDF header (%PDF-).
 */
export function isUndecodedBinary(buffer: Buffer, text?: string | null): boolean {
	if (isPdfBuffer(buffer)) return true;
	if (text && text.trim().startsWith("%PDF-")) return true;
	const headerChunk = buffer.subarray(0, Math.min(buffer.length, 1024));
	return headerChunk.includes(0);
}


import { z } from "zod";
import { isDriveConnector, isEnrichablePointer } from "./selection.js";

/**
 * Pure pointer rules for ingest_discover (ADR-016 Slice 1, #1545).
 *
 * Free of Supabase, OpenAI, and env imports so the pointer normalisation, title
 * synthesis, metadata envelope, origination, and envelope-refresh rules are shared
 * across surfaces in @ahkms/core.
 */

export const discoverInput = {
	connector: z
		.string()
		.regex(
			/^[a-z_]+$/,
			"lowercase letters and underscores only (becomes source_channel discovered_<connector>)",
		)
		.describe(
			"Source system being inventoried, e.g. 'notion', 'gdrive', 'gmail'. Stored as source_channel 'discovered_<connector>'.",
		),
	items: z
		.array(
			z.object({
				external_id: z
					.string()
					.min(1)
					.describe("Stable id of the item in the source system (the idempotency key)."),
				title: z
					.string()
					.nullish()
					.describe(
						"Human-readable title of the item. May be null/empty — real source rows often have no title; a title is then synthesised from `summary` or an explicit `(untitled <type>)` placeholder, so the caller does not have to invent one.",
					),
				summary: z
					.string()
					.optional()
					.describe(
						"Short description/summary of the item, if the source exposes one. Used to synthesise a title when `title` is null/empty.",
					),
				type: z
					.string()
					.optional()
					.describe(
						"Source-system item type (e.g. 'Personal Task', 'page'). Used only for the `(untitled <type>)` placeholder when no title/summary is available; falls back to the connector name.",
					),
				archived: z
					.boolean()
					.optional()
					.describe(
						"Whether the item is archived at the *source* (a `Status: Archived`-style property value, NOT Notion's page-level archive flag). Archived items are excluded from the sweep unless `include_archived` is set.",
					),
				url: z
					.string()
					.url()
					.optional()
					.describe("Direct link to the item where it lives. Content stays there; we store the pointer."),
				owner: z.string().optional().describe("Owner/author in the source system, if known."),
				owner_email: z
					.string()
					.optional()
					.describe("Owner's email in the source system, if known. Tells your files apart from ones shared with you."),
				mime_type: z
					.string()
					.optional()
					.describe(
						"Source-reported MIME type, e.g. 'application/pdf'. A Drive folder ('application/vnd.google-apps.folder') is recorded but never queued for enrichment.",
					),
				size: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe("Size in bytes as the source reports it, if known."),
				envelope: z
					.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
					.optional()
					.describe(
						"Other source-served envelope fields, copied verbatim (e.g. an email's from/to/subject/date). Facts from the API response only, never text read out of the content (ADR-046 §2).",
					),
				parents: z
					.array(z.string())
					.optional()
					.describe("Ids of the item's parent folders/containers in the source system, if known."),
				source_created_at: z
					.string()
					.optional()
					.describe("ISO timestamp the item was created in the source system."),
				source_modified_at: z
					.string()
					.optional()
					.describe("ISO timestamp the item was last modified in the source system."),
				content_hash: z
					.string()
					.optional()
					.describe("Hash/etag of the item's content. Used to detect changes so re-discovery can flag items for re-enrichment."),
				tags: z.array(z.string()).optional().describe("Optional tags."),
				trashed: z
					.boolean()
					.optional()
					.describe("Whether the item is trashed in the source system (#1212)."),
			}),
		)
		.min(1)
		.max(200)
		.describe("Batch of discovered items to register as pointers (max 200 per call)."),
	include_archived: z
		.boolean()
		.optional()
		.describe(
			"Include items flagged `archived` at the source. Default false: store-by-default, but completed/archived items are opt-in on a sweep (docs/vision.md). Applies to the per-item `archived` property value, not Notion's page-level archive flag.",
		),
};

export const discoverSchema = z.object(discoverInput);

export type DiscoverItem = z.infer<typeof discoverSchema>["items"][number];

export function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "item"
	);
}

// Connectors whose URLs carry a volatile per-view tracking suffix (Notion appends
// e.g. `?pvs=1`). Stripping the query/fragment keeps the same page from yielding a
// gratuitously different storage_url each sweep. Drive et al. are left untouched —
// their query params can be load-bearing (e.g. export/resource-key hints).
export const URL_SUFFIX_CONNECTORS = new Set(["notion"]);

// Normalise a pointer's external URL. For suffix-prone connectors, drop the query
// string and fragment so the same page maps to a stable link; leave anything we
// can't parse (or don't recognise) exactly as given.
export function normalizePointerUrl(connector: string, url: string | undefined): string | undefined {
	if (!url || !URL_SUFFIX_CONNECTORS.has(connector)) return url;
	try {
		const parsed = new URL(url);
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

// Test/template rows that should stay out of the knowledge index (issue #428 #4).
// Deliberately conservative — only explicit throwaway markers — so real docs whose
// titles merely contain "test" (e.g. "Testing strategy") are not dropped.
export const JUNK_TITLE_PATTERNS: RegExp[] = [
	/^\s*[[(]\s*(test|template|example|sample|draft|wip)\s*[\])]/i,
	/\bsafe to delete\b/i,
];

// Runs against the *source-provided* strings (title/summary), never the synthesised
// placeholder — an untitled row is stored by default, only genuine junk is skipped.
export function isJunkTitle(value: string | null | undefined): boolean {
	if (!value) return false;
	return JUNK_TITLE_PATTERNS.some((re) => re.test(value));
}

export const MAX_TITLE_LEN = 120;

export function firstLine(value: string): string {
	const line = (value.split(/\r?\n/, 1)[0] ?? "").trim();
	return line.length > MAX_TITLE_LEN ? `${line.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…` : line;
}

// Real source rows often have no title (a Notion row with an empty Name). Rather
// than force the caller to invent one (issue #428 #3), synthesise: prefer a trimmed
// first line of the summary; else an explicit, honest `(untitled <type>)` placeholder
// naming the item type (or the connector when the type is unknown). Store-by-default
// (docs/vision.md): a missing title is not a reason to drop the row.
export function resolveTitle(connector: string, item: DiscoverItem): string {
	const title = item.title?.trim();
	if (title) return title;
	const summary = firstLine(item.summary ?? "");
	if (summary) return summary;
	return `(untitled ${item.type?.trim() || connector})`;
}

// The source-provided summary, persisted to artifacts.description (#427 Part 2).
export function pointerDescription(item: DiscoverItem): string | null {
	return item.summary?.trim() || null;
}

const MAX_EMBED_CHARS = 28_000;

/**
 * The text a pointer is embedded from, or null when it carries no source-provided
 * text worth a vector.
 */
export function pointerEmbedText(item: DiscoverItem, title: string): string | null {
	const sourceTitle = item.title?.trim();
	const description = pointerDescription(item);
	if (!sourceTitle && !description) return null;
	return (
		[title, description]
			.filter(Boolean)
			.join("\n\n")
			.slice(0, MAX_EMBED_CHARS)
			.trim() || null
	);
}

export function pointerProcessingStatus(
	connector: string,
	item: DiscoverItem,
): "pending" | "completed" {
	return isEnrichablePointer(connector, item.mime_type) ? "pending" : "completed";
}

export function pointerUrl(
	connector: string,
	externalId: string,
	url: string | undefined,
): string {
	return url ?? `discovered://${connector}/${externalId}`;
}

export function envelopeFields(item: DiscoverItem): Record<string, unknown> {
	return {
		...(item.owner_email !== undefined ? { owner_email: item.owner_email } : {}),
		...(item.mime_type !== undefined ? { mime_type: item.mime_type } : {}),
		...(item.size !== undefined ? { size: item.size } : {}),
		...(item.envelope !== undefined ? { envelope: item.envelope } : {}),
		...(item.parents !== undefined ? { parents: item.parents } : {}),
	};
}

export function discoveryMetadata(
	connector: string,
	item: DiscoverItem,
	discoveredAt: string,
	url: string | undefined,
) {
	return {
		discovery: {
			connector,
			external_id: item.external_id,
			url: url ?? null,
			owner: item.owner ?? null,
			...envelopeFields(item),
			source_created_at: item.source_created_at ?? null,
			source_modified_at: item.source_modified_at ?? null,
			content_hash: item.content_hash ?? null,
			archived: item.archived ?? null,
			discovered_at: discoveredAt,
		},
	};
}

export function driveColumns(
	connector: string,
	item: DiscoverItem,
): { source_drive_file_id?: string; source_parent_folder_ids?: string[] } {
	if (!isDriveConnector(connector)) return {};
	return {
		source_drive_file_id: item.external_id,
		...(item.parents ? { source_parent_folder_ids: item.parents } : {}),
	};
}

export const ORIGINATION_FIELD_BY_CONNECTOR: Readonly<
	Record<string, "source_created_at" | "source_modified_at">
> = Object.freeze({
	gdrive: "source_created_at",
	google_drive: "source_created_at",
	drive: "source_created_at",
	gdrive_work: "source_created_at",
	onedrive: "source_created_at",
	notion: "source_modified_at",
	gmail_attachment: "source_created_at",
	gmail_attachment_work: "source_created_at",
	local: "source_created_at",
});

export function originationFor(
	connector: string,
	envelope: { source_created_at?: string | null; source_modified_at?: string | null },
): string | undefined {
	const field = ORIGINATION_FIELD_BY_CONNECTOR[connector];
	if (!field) return undefined;
	const raw = envelope[field];
	if (!raw) return undefined;
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function originatedAt(connector: string, item: DiscoverItem): { originated_at?: string } {
	const at = originationFor(connector, item);
	return at ? { originated_at: at } : {};
}

export type ExistingRow = {
	id: string;
	source: string | null;
	processing_metadata: { discovery?: Record<string, unknown>; [key: string]: unknown } | null;
	archived?: boolean | null;
	archived_reason?: string | null;
};

export function needsEnvelopeRefresh(prior: ExistingRow, item: DiscoverItem): boolean {
	return item.mime_type != null && prior.processing_metadata?.discovery?.mime_type == null;
}

export type EnvelopeRefreshRow = {
	id: string;
	envelope: Record<string, unknown>;
	drive_file_id: string | null;
	parent_ids: string[] | null;
	dequeue: boolean;
};

export type DiscoverCounts = {
	inserted: number;
	updated: number;
	unchanged: number;
	refreshed: number;
	skipped: number;
	excluded: number;
	embedded: number;
	embeddable: number;
};

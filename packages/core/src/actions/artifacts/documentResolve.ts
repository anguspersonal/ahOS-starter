import { z } from "zod";
import { collectAliases } from "../../domain/aliases.js";
import type {
	ArtifactRepository,
	DocumentResolveArtifactRow,
} from "../../ports/artifacts.js";
import type {
	EntityRepository,
	TrackedEntityRow,
} from "../../ports/entities.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { discoveryOf, documentLink, str } from "./documentPointer.js";

// document_resolve (#1230, #1622): "get my X". A tracked document (#1216, ADR098) is one
// `resource` entity with `properties.tracked = true` whose properties name the
// golden copy (`canonical_artifact_id`, `canonical_url`, ...) and whose copies and
// versions all link to it `primary`. This action reads that and nothing else: it
// never writes, never guesses a canonical, and when nothing is tracked it says so
// and shows what an owner could track instead (R3: never guess silently).

export const DOCUMENT_RESOLVE_DESCRIPTION =
	"Answer 'get my X': find a tracked document (a resource entity with properties.tracked) by " +
	"query, entity_id or doc_kind and return its canonical copy's link, renditions and every other " +
	"known version. With nothing tracked it says so and lists untracked title matches instead of " +
	"guessing. Full notes: docs/guides/tools/document_resolve.md";

export const documentResolveInput = {
	query: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"What the owner called the document, e.g. 'CV' or 'my CV'. Matches a tracked document whose title or an alias contains it (or appears in it as a word), or whose doc_kind equals it; case-insensitive.",
		),
	entity_id: z.string().uuid().optional().describe("The tracked document's entity id, when already known."),
	doc_kind: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.optional()
		.describe("The tracked document's properties.doc_kind, e.g. 'cv'. Exact match, case-insensitive."),
	include_archived: z
		.boolean()
		.optional()
		.describe(
			"Also list archived versions (with their archived_reason, e.g. 'superseded:<id>') and archived tracked documents. Defaults to false; hidden archived versions are still counted.",
		),
	limit: z.number().int().min(1).max(20).optional().describe("Max tracked documents to return (default 5)."),
};

export const documentResolveSchema = z.object(documentResolveInput);
export type DocumentResolveInput = z.infer<typeof documentResolveSchema>;

export interface DocumentResolveResult {
	text: string;
}

export type DocumentResolveArtifactsPort = Pick<
	ArtifactRepository,
	"getDocumentsByIds" | "getPrimaryLinksForEntities" | "searchDocumentTitleCandidates"
>;

export type DocumentResolveEntitiesPort = Pick<
	EntityRepository,
	"findTrackedResources" | "getTitleById"
>;

export interface DocumentResolvePorts {
	artifacts: DocumentResolveArtifactsPort;
	entities: DocumentResolveEntitiesPort;
}

/** Tracked documents are hand-curated and few; past this many, say so rather than guess. */
const TRACKED_SCAN_CAP = 500;
/** The untracked fallback's list length, per the batch contract. */
const CANDIDATE_CAP = 10;
/** Words of a request the fallback's title search uses at most. */
const MAX_TITLE_TERMS = 8;

/**
 * Words a document title never needs to carry for a request to mean it: English
 * function words (Postgres's `english` stopword list, abridged) and the phrasing of a
 * "get me X" request. "get my latest CV" searches titles for `cv`.
 */
const REQUEST_STOPWORDS = new Set([
	"a", "about", "all", "an", "and", "any", "are", "as", "at", "be", "by", "for", "from",
	"has", "have", "i", "in", "is", "it", "its", "me", "mine", "my", "of", "on", "or", "our",
	"ours", "that", "the", "their", "this", "to", "was", "we", "what", "where", "which",
	"with", "you", "your",
	"copy", "current", "fetch", "find", "get", "give", "latest", "newest", "open", "recent",
	"show", "version",
]);

type Rendition = { format: string | null; artifact_id: string | null; url: string | null };

/** Whether `needle` appears in `hay` as a whole word (Unicode letters/digits as word chars). */
function containsWord(hay: string, needle: string): boolean {
	if (!needle) return false;
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(hay);
}

/**
 * Whether a tracked document answers the caller's criteria, and how strongly.
 * Every criterion given must hold. `query` matches the title or an alias by
 * substring either way round (a query naming the alias as a word, "my CV", counts),
 * or the doc_kind exactly; `exact` marks an equal title/alias/doc_kind so those
 * rank first.
 */
export function matchTrackedDocument(
	entity: Pick<TrackedEntityRow, "title" | "aliases" | "properties">,
	criteria: { query?: string; doc_kind?: string },
): { match: boolean; exact: boolean } {
	const docKind = str(entity.properties?.doc_kind)?.toLowerCase() ?? null;
	if (criteria.doc_kind && docKind !== criteria.doc_kind.trim().toLowerCase()) {
		return { match: false, exact: false };
	}
	if (!criteria.query) return { match: true, exact: Boolean(criteria.doc_kind) };

	const q = criteria.query.trim().toLowerCase();
	const names = [entity.title ?? "", ...collectAliases(entity)]
		.map((n) => n.trim().toLowerCase())
		.filter(Boolean);
	const exact = names.includes(q) || docKind === q;
	const match =
		exact ||
		names.some((n) => n.includes(q) || containsWord(q, n)) ||
		(docKind !== null && containsWord(q, docKind));
	return { match, exact };
}

/** The renditions array off a tracked document's properties, tolerating bad shapes. */
function renditionsOf(properties: Record<string, unknown> | null): Rendition[] {
	const raw = properties?.renditions;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
		.map((r) => ({ format: str(r.format), artifact_id: str(r.artifact_id), url: str(r.url) }));
}

/**
 * The words to look for in document titles: the text's letter/digit runs,
 * lower-cased, without request phrasing or one-character noise ("get my CV" ->
 * ["cv"], "Driving licence 2024" -> ["driving", "licence", "2024"]). If nothing is
 * left, every word is kept rather than searching for nothing ("my" -> ["my"]).
 */
export function titleSearchTerms(text: string): string[] {
	const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
	const kept = words.filter((w) => w.length > 1 && !REQUEST_STOPWORDS.has(w));
	return (kept.length > 0 ? kept : words).slice(0, MAX_TITLE_TERMS);
}

function quoteTerms(terms: string[]): string {
	const quoted = terms.map((t) => `"${t}"`);
	return quoted.length === 1 ? quoted[0] : `any of ${quoted.join(", ")}`;
}

function modifiedAt(row: DocumentResolveArtifactRow): string | null {
	return str(discoveryOf(row.processing_metadata)?.source_modified_at);
}

function surfaceLabel(row: DocumentResolveArtifactRow): string {
	const connector = str(discoveryOf(row.processing_metadata)?.connector);
	const surface = row.surface ?? row.source_channel ?? "?";
	return connector && !surface.endsWith(connector) ? `${surface} (${connector})` : surface;
}

/** One version line: id, title, link, surface, source-modified date, archived state. */
function versionLine(row: DocumentResolveArtifactRow, note = ""): string {
	const parts = [
		`[${row.id}] ${row.title ?? "(untitled)"}${note}`,
		documentLink(row) ?? "(no link)",
		surfaceLabel(row),
		`modified ${modifiedAt(row) ?? "unknown"}`,
	];
	if (row.archived) parts.push(`archived (${row.archived_reason ?? "no reason recorded"})`);
	return `  - ${parts.join(" · ")}`;
}

/** Newest source modification first; undated last; then by title. */
function byModifiedDesc(a: DocumentResolveArtifactRow, b: DocumentResolveArtifactRow): number {
	const ma = modifiedAt(a) ?? "";
	const mb = modifiedAt(b) ?? "";
	if (ma !== mb) return ma < mb ? 1 : -1;
	return (a.title ?? "").localeCompare(b.title ?? "");
}

function renderTracked(
	entity: TrackedEntityRow,
	linked: string[],
	artifacts: Map<string, DocumentResolveArtifactRow>,
	includeArchived: boolean,
): string {
	const props = entity.properties ?? {};
	const docKind = str(props.doc_kind);
	const aliases = collectAliases(entity);
	const lines: string[] = [
		`## ${entity.title ?? "(untitled tracked document)"}`,
		[
			`Entity: ${entity.id}`,
			`doc_kind: ${docKind ?? "(none)"}`,
			...(aliases.length ? [`aliases: ${aliases.join(", ")}`] : []),
			...(entity.archived ? ["archived"] : []),
		].join(" · "),
	];

	const canonicalId = str(props.canonical_artifact_id);
	const canonicalUrl = str(props.canonical_url);
	const setAt = str(props.canonical_set_at);
	const setBy = str(props.canonical_set_by);
	const canonical = canonicalId ? artifacts.get(canonicalId) : undefined;
	if (!canonicalId) {
		lines.push("Canonical: (none set; the golden-doc skill's set-canonical mode sets one)");
		if (canonicalUrl) lines.push(`  Link: ${canonicalUrl}`);
	} else if (!canonical) {
		lines.push(`Canonical: [${canonicalId}] (artifact not found: deleted, or not this owner's)`);
		if (canonicalUrl) lines.push(`  Link: ${canonicalUrl}`);
	} else {
		const disc = discoveryOf(canonical.processing_metadata);
		const format = str(disc?.mime_type) ?? canonical.file_type;
		lines.push(
			`Canonical: [${canonical.id}] ${canonical.title ?? "(untitled)"}`,
			`  Link: ${canonicalUrl ?? documentLink(canonical) ?? "(no link)"}`,
			`  Surface: ${surfaceLabel(canonical)}`,
			`  Format: ${format ?? "(unknown)"}`,
			`  Modified at source: ${modifiedAt(canonical) ?? "(unknown)"}`,
		);
		if (canonical.archived) {
			lines.push(`  ⚠️ The canonical copy is archived (${canonical.archived_reason ?? "no reason recorded"}).`);
		}
	}
	if (canonicalId || setAt) {
		lines.push(`  Canonical set: ${setAt ?? "(unknown)"}${setBy ? ` by ${setBy}` : ""}`);
	}

	const renditions = renditionsOf(props);
	if (renditions.length === 0) {
		lines.push("Renditions: none");
	} else {
		lines.push(`Renditions (${renditions.length}):`);
		for (const r of renditions) {
			const row = r.artifact_id ? artifacts.get(r.artifact_id) : undefined;
			const link = r.url ?? (row ? documentLink(row) : null) ?? "(no link)";
			lines.push(`  - ${r.format ?? "?"}: ${link}${r.artifact_id ? ` [${r.artifact_id}]` : ""}`);
		}
	}

	const renditionFormat = new Map(
		renditions.filter((r) => r.artifact_id).map((r) => [r.artifact_id as string, r.format ?? "?"]),
	);
	const others = linked.filter((id) => id !== canonicalId);
	const found = others
		.map((id) => artifacts.get(id))
		.filter((r): r is DocumentResolveArtifactRow => Boolean(r));
	const missing = others.length - found.length;
	const shown = found.filter((r) => includeArchived || !r.archived).sort(byModifiedDesc);
	const hiddenArchived = found.length - shown.length;
	if (shown.length === 0) {
		lines.push("Other versions: none");
	} else {
		lines.push(`Other versions (${shown.length}):`);
		for (const row of shown) {
			const format = renditionFormat.get(row.id);
			lines.push(versionLine(row, format ? ` (rendition: ${format})` : ""));
		}
	}
	// No silent caps: what is not listed is counted.
	if (hiddenArchived > 0) {
		lines.push(`  (${hiddenArchived} archived version(s) hidden; pass include_archived: true to list them)`);
	}
	if (missing > 0) {
		lines.push(`  (${missing} linked artifact(s) not found: deleted, or not this owner's)`);
	}
	return lines.join("\n");
}

/**
 * Nothing tracked matches: say so, then list what an owner could track -- up to ten
 * documents whose title contains a word of the request, archived excluded -- rather
 * than picking one. The words come from the query, else the doc_kind, else the named
 * entity's own title when it exists but is not tracked. The search is the
 * `document_title_candidates` RPC (migration 119): the discovered-pointer index,
 * matched on its covering title index, so no call walks the artifacts heap.
 */
async function untrackedFallback(
	ports: DocumentResolvePorts,
	args: DocumentResolveInput,
	userId?: string,
): Promise<string> {
	const asked = args.query ?? args.doc_kind ?? args.entity_id ?? "";
	const lines = [`No tracked document matches "${asked}".`];

	let text = args.query ?? args.doc_kind ?? null;
	if (!text && args.entity_id) {
		text = await ports.entities.getTitleById(args.entity_id, userId);
	}
	const terms = text ? titleSearchTerms(text) : [];

	if (terms.length === 0) {
		lines.push("No untracked candidates: there is no title to search on.");
	} else {
		const found = await ports.artifacts.searchDocumentTitleCandidates(
			terms,
			CANDIDATE_CAP + 1,
			userId,
		);
		const rows = found.slice(0, CANDIDATE_CAP).sort(byModifiedDesc);
		const described = quoteTerms(terms);
		if (rows.length === 0) {
			lines.push(`No untracked candidates either: no discovered document's title contains ${described}.`);
		} else {
			lines.push(`Untracked candidates (discovered documents whose title contains ${described}, archived excluded):`);
			for (const row of rows) lines.push(versionLine(row));
			if (found.length > CANDIDATE_CAP) {
				lines.push(`  (more than ${CANDIDATE_CAP} titles match; narrow the query to see others)`);
			}
		}
	}
	lines.push("Run the golden-doc skill to track one.");
	return lines.join("\n");
}

export function formatDocumentResolveMcp(result: DocumentResolveResult): string {
	return result.text;
}

export function createDocumentResolveAction(
	ports: DocumentResolvePorts,
): ActionDefinition<typeof documentResolveSchema, DocumentResolveResult> {
	return defineAction({
		id: "document_resolve",
		domain: "artifacts",
		description: DOCUMENT_RESOLVE_DESCRIPTION,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		schema: documentResolveSchema,
		run: async (args, ctx) => {
			if (!args.query && !args.entity_id && !args.doc_kind) {
				throw new Error("document_resolve: provide at least one of query, entity_id, doc_kind.");
			}
			const limit = args.limit ?? 5;
			const includeArchived = args.include_archived ?? false;
			const userId = ctx.userId;

			const tracked = await ports.entities.findTrackedResources(
				{
					entity_id: args.entity_id,
					include_archived: args.include_archived,
					limit: TRACKED_SCAN_CAP + 1,
				},
				userId,
			);
			const scanned = tracked.slice(0, TRACKED_SCAN_CAP);
			const matches = scanned
				.map((entity) => ({ entity, ...matchTrackedDocument(entity, args) }))
				.filter((m) => m.match)
				.sort(
					(a, b) =>
						Number(b.exact) - Number(a.exact) ||
						(a.entity.title ?? "").localeCompare(b.entity.title ?? ""),
				);

			if (matches.length === 0) {
				return { text: await untrackedFallback(ports, args, userId) };
			}

			const chosen = matches.slice(0, limit).map((m) => m.entity);
			const links = await ports.artifacts.getPrimaryLinksForEntities(chosen.map((e) => e.id));
			const artifactIds = new Set<string>();
			for (const entity of chosen) {
				for (const id of links.get(entity.id) ?? []) artifactIds.add(id);
				const canonicalId = str(entity.properties?.canonical_artifact_id);
				if (canonicalId) artifactIds.add(canonicalId);
				for (const r of renditionsOf(entity.properties)) {
					if (r.artifact_id) artifactIds.add(r.artifact_id);
				}
			}
			const artifacts = await ports.artifacts.getDocumentsByIds([...artifactIds], userId);

			const blocks = chosen.map((entity) =>
				renderTracked(entity, links.get(entity.id) ?? [], artifacts, includeArchived),
			);
			const header = `${matches.length} tracked document(s) match.`;
			const notes: string[] = [];
			if (matches.length > chosen.length) {
				notes.push(`⚠️ ${matches.length - chosen.length} more not shown; raise \`limit\` or pass entity_id.`);
			}
			if (tracked.length > TRACKED_SCAN_CAP) {
				notes.push(
					`⚠️ More than ${TRACKED_SCAN_CAP} tracked documents exist; only the first ${TRACKED_SCAN_CAP} by title were matched. Pass entity_id to reach any other.`,
				);
			}
			const text = [header, ...blocks, ...notes].join("\n\n");
			return { text };
		},
		formatMcp: formatDocumentResolveMcp,
	});
}

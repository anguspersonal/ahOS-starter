import { z } from "zod";
import { supabase } from "../supabase.js";
import { env } from "../env.js";
import { getCurrentUserId } from "../identity.js";
import { buildStorageUrl, isTextual } from "../kms/artifacts.js";
import { extractTextHandler } from "./extract.js";
import { embedAndStore } from "../embeddings.js";
import { getReadAdapter, supportedConnectors } from "./enrich/adapters.js";
import {
	connectorOf,
	channelsForConnector,
	isPdfBuffer,
	isUndecodedBinary,
	isUrlConnector,
	NOT_A_FOLDER_FILTER,
} from "@ahkms/core";
import { generateL2Summary } from "./enrich/summary.js";
import { DISCOVERED_STAGE, EXTRACTED_STAGE, FAILED_STAGE } from "../vocab.js";

// ingest_enrich_next: the expensive, budgeted half of the two-cadence Discover & Index
// model (ADR-016, Slice 2, #52). `ingest_discover` (Slice 1) registers cheap pointers
// with lifecycle_stage='discovered' and no content. This tool pops the N most recently
// modified such pointers and enriches each in place:
//
//   fetch content (connector-specific read adapter)
//     -> store the bytes in the app bucket (so it's a real artifact)
//     -> artifact_extract_text (best-effort; missing key / model error never fails the batch)
//     -> advance lifecycle_stage 'discovered' -> 'extracted'
//     -> refresh discovery.content_hash so re-discovery diffing keeps working
//
// Budgeted (limit), idempotent, and failure-isolated: one pointer failing does
// not abort the batch. Pointers from connectors with no server-side read adapter
// (Notion, Gmail today) are simply not selected, so they stay queued rather than
// being burned by a failing enrich.

export const enrichNextInput = {
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe("Max pointers to enrich this call (the budget). Default 10."),
	connector: z
		.string()
		.regex(/^[a-z_]+$/, "lowercase letters and underscores only")
		.optional()
		.describe(
			"Only enrich pointers discovered from this connector (e.g. 'gdrive' or 'url'). Omit to drain the oldest across all connectors we can read.",
		),
	artifact_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Enrich a specific artifact on-demand by UUID (e.g. an artifact whose body is only a source_url, or a specific discovered pointer).",
		),
	artifact_ids: z
		.array(z.string().uuid())
		.optional()
		.describe(
			"Enrich a list of specific artifacts on-demand by UUIDs outside the daily budget (e.g. all CV copies).",
		),
};

const enrichNextSchema = z.object(enrichNextInput);

export type EnrichedRow = {
	id: string;
	title: string | null;
	description?: string | null;
	source: string | null;
	source_channel: string | null;
	storage_bucket?: string | null;
	storage_path?: string | null;
	storage_url: string | null;
	source_url?: string | null;
	plain_text?: string | null;
	lifecycle_stage?: string | null;
	processing_metadata: { discovery?: Record<string, unknown>; enrichment_error?: string } | null;
};

/**
 * Returns true if an artifact row represents a URL-only capture whose page
 * text has not yet been fetched and stored into L3 storage.
 */
export function isUrlOnlyArtifact(row: {
	source_url?: string | null;
	source?: string | null;
	plain_text?: string | null;
	storage_bucket?: string | null;
	storage_path?: string | null;
}): boolean {
	const url =
		row.source_url ||
		(row.source && /^https?:\/\//i.test(row.source) ? row.source : null);
	if (!url) return false;

	if (row.storage_path && row.storage_bucket && row.storage_bucket !== "external") {
		return false;
	}

	const text = (row.plain_text || "").trim();
	return !text || text === url || /^https?:\/\/\S+$/i.test(text);
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The size of the enrich backlog, or an error saying why it could not be counted
 * (#1209). Never a silent 0.
 *
 * `estimated`, not `exact`: PostgREST counts exactly up to its max-rows threshold
 * (Supabase's API "Max rows" setting) and returns the planner's row estimate beyond
 * it. An exact count over ~150k wide Drive pointer rows timed out
 * (57014) on every scheduled run (the same class as #593/#596) and the old code
 * dropped the error and returned `count ?? 0`, so the cadence recorded
 * `status='ok', remaining_discovered=0` while the whole estate sat queued. A backlog
 * this size needs its order of magnitude, not its last digit.
 */
async function countDiscovered(
	channels: string[],
): Promise<{ count: number | null; error?: string }> {
	const { count, error } = await supabase
		.from("artifacts")
		.select("id", { count: "estimated", head: true })
		.eq("user_id", getCurrentUserId())
		.eq("lifecycle_stage", DISCOVERED_STAGE)
		.eq("archived", false)
		.in("source_channel", channels)
		.or(NOT_A_FOLDER_FILTER);
	if (error) return { count: null, error: error.message || "backlog count failed" };
	if (count == null) return { count: null, error: "backlog count returned no count" };
	return { count };
}

// Isolate a per-item failure: take the pointer out of the 'discovered' backlog so
// it does not consume budget on every run. A later `ingest_discover` that sees changed
// content resets it to 'discovered' and it gets retried.
async function markFailed(row: EnrichedRow, message: string): Promise<void> {
	await supabase
		.from("artifacts")
		.update({
			lifecycle_stage: FAILED_STAGE,
			processing_status: "failed",
			processing_metadata: {
				...(row.processing_metadata ?? {}),
				enrichment_error: message,
				enrichment_failed_at: new Date().toISOString(),
			},
		})
		.eq("id", row.id)
		.eq("user_id", getCurrentUserId());
}

export async function enrichOne(row: EnrichedRow): Promise<{ note?: string }> {
	const isUrl = isUrlOnlyArtifact(row);
	const connector = isUrl ? "url" : connectorOf(row);
	const adapter = connector ? getReadAdapter(connector) : undefined;
	if (!connector || !adapter) {
		throw new Error(`no read adapter for connector '${connector ?? "?"}'`);
	}
	const externalId = isUrl ? (row.source_url || row.source) : row.source;
	if (!externalId) throw new Error("pointer has no external id (artifacts.source)");

	const targetUrl = isUrl ? (row.source_url || row.source) : row.storage_url;

	// a. fetch the content from the source system (connector-specific).
	const fetched = await adapter.fetch({ connector, externalId, url: targetUrl });

	// Catch misdeclared files where mimeType was set to application/json or text/plain
	// but the buffer is actually a PDF (#1229).
	if (isPdfBuffer(fetched.buffer)) {
		fetched.mimeType = "application/pdf";
		fetched.extension = fetched.extension ?? "pdf";
	}

	// b. store the bytes in the app bucket, mirroring drive_import_file. upsert so a
	//    retry after a partial failure overwrites rather than 409s.
	const ext = fetched.extension;
	const storagePath = `enriched/${connector}/${getCurrentUserId()}/${row.id}${ext ? `.${ext}` : ""}`;
	const { error: uploadError } = await supabase.storage
		.from(env.storageBucket)
		.upload(storagePath, fetched.buffer, {
			contentType: fetched.mimeType,
			upsert: true,
		});
	if (uploadError) throw new Error(`storage upload failed: ${uploadError.message}`);

	const isBinary = isUndecodedBinary(fetched.buffer);
	const textual = !isBinary && isTextual(fetched.mimeType);
	// Prefer the adapter's pre-extracted text (e.g. HTML with tags/scripts
	// stripped) over the raw bytes: buffer may hold un-cleaned source
	// markup, and reusing it as-is here previously leaked raw HTML into
	// plain_text/embeddings (#638 round-1 QA finding).
	const plainText = textual ? (fetched.text ?? fetched.buffer.toString("utf-8")) : null;

	// c. promote the pointer: it now carries real bytes and is searchable. Refresh
	//    discovery.content_hash to the version we just enriched so the next discover
	//    pass diffs against what was actually processed.
	const priorDiscovery = (row.processing_metadata?.discovery ?? {}) as Record<
		string,
		unknown
	>;
	const newTitle =
		fetched.sourceName && (!row.title || row.title === externalId || /^https?:\/\//i.test(row.title))
			? fetched.sourceName
			: row.title;

	// Generate neutral 1-2 sentence L2 summary for textual content (#1229).
	// (Binary documents will generate their L2 summary after extraction in extractTextHandler).
	let summary: string | null = null;
	if (textual && plainText) {
		const summaryResult = await generateL2Summary(plainText, newTitle);
		summary = summaryResult.summary;
	}
	const newDescription = summary ?? row.description ?? null;

	const { error: updateError } = await supabase
		.from("artifacts")
		.update({
			storage_bucket: env.storageBucket,
			storage_path: storagePath,
			storage_url: buildStorageUrl(env.storageBucket, storagePath),
			file_type: fetched.mimeType,
			content_type: fetched.mimeType,
			file_extension: ext,
			file_size: fetched.buffer.length,
			plain_text: plainText,
			title: newTitle,
			description: newDescription,
			lifecycle_stage: EXTRACTED_STAGE,
			processing_status: textual ? "completed" : "pending",
			processing_metadata: {
				...(row.processing_metadata ?? {}),
				discovery: {
					...priorDiscovery,
					connector: priorDiscovery.connector ?? (isUrl ? "url" : connector),
					content_hash: fetched.contentHash ?? priorDiscovery.content_hash ?? null,
					enriched_at: new Date().toISOString(),
				},
			},
		})
		.eq("id", row.id)
		.eq("user_id", getCurrentUserId());
	if (updateError) throw new Error(`row update failed: ${updateError.message}`);

	// d. make the content semantically retrievable, not just FTS-searchable.
	//    - Binary (PDF/image): extractTextHandler runs the extraction model, which
	//      itself embeds the extracted text.
	//    - Textual: the bytes are already stored as plain_text above (no extraction
	//      model call needed), but it still requires an embedding or it stays absent
	//      from semantic/hybrid search. Mirror extract.ts's embedAndStore(plain_text).
	//    Both are best-effort: a missing key or model error must NOT fail the item:
	//    the content is captured and FTS-searchable either way (embedAndStore never
	//    throws; extraction is wrapped below).
	if (!textual) {
		try {
			await extractTextHandler({ artifact_id: row.id });
		} catch (err) {
			return { note: `${row.id}: stored, text extraction degraded (${errMessage(err)})` };
		}
	} else if (plainText) {
		await embedAndStore("artifacts", row.id, {
			title: newTitle,
			description: newDescription,
			plain_text: plainText,
		});
	}
	return {};
}

export type EnrichCounts = {
	enriched: number;
	failed: number;
	/**
	 * The backlog left after this call (an estimate at scale: see countDiscovered),
	 * or null when it was not counted. Null, never 0: a 0 here is read as "the
	 * backlog is empty" (#1209). Two reasons for null:
	 *   - the count failed: `count_error` says why;
	 *   - a single-artifact call (`artifact_id`) never counts the backlog, and has
	 *     no `count_error`, because nothing failed.
	 */
	remaining_discovered: number | null;
	count_error?: string;
	notes: string[];
};

// Core budgeted-enrich logic, factored out of enrichNextHandler so callers that
// need structured counts (the scheduled enrich cadence, #53) don't have to parse
// the human-readable summary text.
export async function enrichNextCore(
	args: z.infer<typeof enrichNextSchema>,
): Promise<EnrichCounts> {
	const limit = args.limit ?? 10;
	const supported = supportedConnectors();

	const onDemandIds = [
		...(args.artifact_id ? [args.artifact_id] : []),
		...(args.artifact_ids ?? []),
	];
	const uniqueOnDemandIds = [...new Set(onDemandIds)];

	// On-demand enrichment for specific artifact ID(s) (#638 §2, #1229). It does not
	// count the backlog (that is a second, expensive query nobody asked for here), so
	// every return below says `remaining_discovered: null` rather than a made-up 0.
	if (uniqueOnDemandIds.length > 0) {
		let enriched = 0;
		let failed = 0;
		const notes: string[] = [];

		for (const targetId of uniqueOnDemandIds) {
			const { data: row, error } = await supabase
				.from("artifacts")
				.select(
					"id, title, description, source, source_channel, storage_bucket, storage_path, storage_url, source_url, plain_text, lifecycle_stage, processing_status, processing_metadata",
				)
				.eq("user_id", getCurrentUserId())
				.eq("id", targetId)
				.maybeSingle();

			if (error) {
				failed += 1;
				notes.push(`${targetId}: FAILED to load: ${error.message}`);
				continue;
			}
			if (!row) {
				failed += 1;
				notes.push(`${targetId}: artifact not found`);
				continue;
			}

			if (
				row.storage_path &&
				row.storage_bucket &&
				row.storage_bucket !== "external" &&
				row.lifecycle_stage !== DISCOVERED_STAGE &&
				!isUrlOnlyArtifact(row)
			) {
				notes.push(`${row.id}: already enriched (storage_path: ${row.storage_path})`);
				continue;
			}

			try {
				const { note } = await enrichOne(row as EnrichedRow);
				enriched += 1;
				if (note) notes.push(note);
				else notes.push(`${row.id}: enriched successfully`);
			} catch (err) {
				failed += 1;
				const message = errMessage(err);
				notes.push(`${row.id}: FAILED, ${message}`);
				await markFailed(row as EnrichedRow, message);
			}
		}

		return {
			enriched,
			failed,
			remaining_discovered: null,
			notes,
		};
	}

	// An explicit connector with no read adapter: don't touch any rows; leave the
	// backlog intact for when an adapter lands.
	if (args.connector && !getReadAdapter(args.connector)) {
		const backlog = await countDiscovered(channelsForConnector(args.connector, supported));
		return {
			enriched: 0,
			failed: 0,
			remaining_discovered: backlog.count,
			...(backlog.error ? { count_error: backlog.error } : {}),
			notes: [
				`no server-side read adapter for connector '${args.connector}' yet ` +
					`(enrichable: ${supported.join(", ") || "none"}). Pointers left queued.`,
			],
		};
	}

	const channels = channelsForConnector(args.connector, supported);
	const selectFields =
		"id, title, description, source, source_channel, storage_bucket, storage_path, storage_url, source_url, plain_text, lifecycle_stage, processing_metadata";
	const { data: rows, error } = await supabase
		.from("artifacts")
		.select(selectFields)
		.eq("user_id", getCurrentUserId())
		.eq("lifecycle_stage", DISCOVERED_STAGE)
		.eq("archived", false)
		.in("source_channel", channels)
		// A recorded Drive folder never gets picked (#1228): it has no bytes, so it
		// would only spend a unit of the budget on a certain failure.
		.or(NOT_A_FOLDER_FILTER)
		.order("effective_at", { ascending: false })
		.order("captured_at", { ascending: false })
		.limit(limit);

	if (error) throw new Error(`ingest_enrich_next selection failed: ${error.message}`);

	let enriched = 0;
	let failed = 0;
	const notes: string[] = [];

	for (const row of (rows ?? []) as EnrichedRow[]) {
		try {
			const { note } = await enrichOne(row);
			if (note) notes.push(note);
			enriched += 1;
		} catch (err) {
			failed += 1;
			const message = errMessage(err);
			notes.push(`${row.id}: FAILED, ${message}`);
			await markFailed(row, message);
		}
	}

	const backlog = await countDiscovered(channels);
	return {
		enriched,
		failed,
		remaining_discovered: backlog.count,
		...(backlog.error ? { count_error: backlog.error } : {}),
		notes,
	};
}

export async function enrichNextHandler(
	args: z.infer<typeof enrichNextSchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	const { enriched, failed, remaining_discovered, count_error, notes } = await enrichNextCore(args);
	const supported = supportedConnectors();
	const onDemandCount = (args.artifact_id ? 1 : 0) + (args.artifact_ids?.length ?? 0);
	const scope = onDemandCount > 0
		? onDemandCount === 1
			? `artifact ${args.artifact_id ?? args.artifact_ids?.[0]}`
			: `${onDemandCount} on-demand artifacts`
		: args.connector
			? `connector ${args.connector}`
			: `connectors: ${supported.join(", ")}`;
	// An on-demand call did not count the backlog, so it says nothing about it.
	const remaining = onDemandCount > 0
		? ""
		: remaining_discovered == null
			? `, unknown discovered remaining (backlog count failed: ${count_error ?? "no count"})`
			: `, ${remaining_discovered} discovered remaining`;
	const summary =
		`ingest_enrich_next: ${enriched} enriched, ${failed} failed${remaining} (${scope}).` +
		(notes.length ? `\n${notes.join("\n")}` : "");

	return { content: [{ type: "text", text: summary }] };
}

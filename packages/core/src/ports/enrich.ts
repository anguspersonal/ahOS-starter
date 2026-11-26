/**
 * Ports for enrichment, connector content reading, and L2 summarization (ADR-101 §1, §4, #1627).
 * Pure types only. No external SDKs, database, or environment dependencies.
 */

export interface PointerRef {
	/** The discovery.connector value (e.g. 'gdrive'). */
	connector: string;
	/** The stable id of the item in the source system (artifacts.source). */
	externalId: string;
	/** The external link recorded at discovery time, if any. */
	url: string | null;
}

export interface FetchedContent {
	buffer: Buffer;
	mimeType: string;
	extension: string | null;
	/**
	 * A change-signal for the version we just fetched, in the same space as the
	 * connector hash `ingest_discover` records, so re-discovery diffing keeps working. May
	 * be null when the source exposes no stable hash.
	 */
	contentHash: string | null;
	/** Source-system name, used to keep the pointer's title/filename honest. */
	sourceName: string | null;
	/**
	 * Pre-extracted plain text, when the adapter already knows how to strip
	 * the source format's noise (e.g. HTML tags/scripts). When set, callers
	 * must prefer this over `buffer.toString()` for `plain_text`/embeddings (
	 * `buffer` may hold raw markup, not readable text). Null when the adapter
	 * has no extraction of its own (the caller falls back to the raw bytes).
	 */
	text: string | null;
}

export interface ReadAdapter {
	/** The discovery.connector value this adapter handles. */
	connector: string;
	fetch(ref: PointerRef): Promise<FetchedContent>;
}

export interface EnrichSourcePort {
	getReadAdapter?(connector: string): ReadAdapter | undefined;
	supportedConnectors?(): string[];
	fetch?(ref: PointerRef): Promise<FetchedContent>;
}

export interface SummaryResult {
	summary: string | null;
	skipReason?: string;
}

export interface AnthropicSummaryClient {
	messages: {
		create(args: {
			model: string;
			max_tokens: number;
			messages: Array<{
				role: "user";
				content: Array<{ type: string; text: string }>;
			}>;
		}): Promise<{ content: Array<{ type: string; text?: string }> }>;
	};
}

export interface GeminiSummaryClient {
	models: {
		generateContent(args: {
			model: string;
			contents: string | Array<Record<string, unknown>>;
			config?: Record<string, unknown>;
		}): Promise<{
			text?: string;
			candidates?: Array<{ finishReason?: string }>;
		}>;
	};
}

export interface GenerateL2SummaryOptions {
	apiKey?: string;
	geminiApiKey?: string;
	provider?: "gemini" | "anthropic";
	model?: string;
	geminiModel?: string;
	client?: AnthropicSummaryClient;
	geminiClient?: GeminiSummaryClient;
}

export interface L2SummaryPort {
	generateL2Summary(
		text: string | null | undefined,
		title?: string | null,
		options?: GenerateL2SummaryOptions,
	): Promise<SummaryResult>;
}

/** The artifact columns enrich reads; `processing_status` only on the on-demand load (#2322). */
export interface EnrichPointerRow {
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
	processing_status?: string | null;
	processing_metadata: { discovery?: Record<string, unknown>; [key: string]: unknown } | null;
}

/** What a successful read hands to `promote`. `captured_at` and `originated_at` are never written. */
export interface EnrichPromotePatch {
	storageBucket: string;
	storagePath: string;
	storageUrl: string | null;
	mimeType: string;
	extension: string | null;
	fileSize: number;
	plainText: string | null;
	title: string | null;
	description: string | null;
	processingStatus: "completed" | "pending";
	/** The pointer's metadata as loaded: every key survives and `discovery` is merged into. */
	processingMetadata: EnrichPointerRow["processing_metadata"];
	/** Recorded as `discovery.connector` only when discovery did not record one. */
	connector: string;
	/** Hash of the version just fetched; null keeps the hash discovery recorded. */
	contentHash: string | null;
}

/** Every database read and write `ingest_enrich_next` makes (ADR-101 §4, #2322). */
export interface EnrichRepository {
	/** The newest discovered, unarchived, non-folder pointers on these channels. */
	selectDiscovered(userId: string, options: { channels: string[]; limit: number }): Promise<EnrichPointerRow[]>;
	/** An estimated count over the same filters, or why it failed. Never a silent 0 (#1209). */
	countDiscovered(userId: string, channels: string[]): Promise<{ count: number | null; error?: string }>;
	/** One artifact for the on-demand path; null when the user has no such row. */
	loadById(userId: string, id: string): Promise<EnrichPointerRow | null>;
	/** Takes a pointer out of the backlog, keeping its metadata. Best-effort: a database error is not raised. */
	markFailed(userId: string, row: Pick<EnrichPointerRow, "id" | "processing_metadata">, message: string): Promise<void>;
	/** Advances a pointer to `extracted` with its stored bytes and refreshed discovery metadata. */
	promote(userId: string, id: string, patch: EnrichPromotePatch): Promise<void>;
}

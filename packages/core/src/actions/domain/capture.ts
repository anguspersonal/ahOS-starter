import { z } from "zod";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";

export const SOURCE_URL_MAX_LENGTH = 2048;

export const TRUST_TIERS = ["perfect", "high", "medium", "low", "unverified"] as const;
export const trustTier = z.enum(TRUST_TIERS);
export type TrustTier = (typeof TRUST_TIERS)[number];

export const URGENCY_LEVELS = ["throw", "default", "file"] as const;
export const urgencyLevel = z.enum(URGENCY_LEVELS);
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const BACKDATABLE_CONTENT_SUBTYPES = ["daily_log", "reflection"] as const;

export const captureInput = {
	text: z.string().min(1).describe("The note / content body to store."),
	title: z
		.string()
		.optional()
		.describe("Optional title. Derived from the first line of text if omitted."),
	// Capped because it is also written to `artifacts.source`, which migration 118's
	// non-partial (user_id, source_channel, source) btree indexes on every row: a key
	// over ~2700 bytes fails the insert with an opaque "index row size exceeds btree
	// version 4 maximum". 2048 is the conventional URL ceiling, well under that for
	// any real URL. Rejecting here gives the caller a plain validation error instead.
	source_url: z
		.string()
		.url()
		.max(SOURCE_URL_MAX_LENGTH)
		.optional()
		.describe(`Optional URL this note came from (at most ${SOURCE_URL_MAX_LENGTH} characters).`),
	tags: z.array(z.string()).optional().describe("Optional tags."),
	content_subtype: z
		.string()
		.optional()
		.describe(
			"Optional kind of content, e.g. 'transcript', 'conversation', 'note'. Also carries an explicit user-supplied content-type flag ('task' | 'note' | 'reference' | 'quote' | 'person' | 'meeting-note') when the user typed one — pass it through as given, never inferred from the content (capture is dumb; auto-detection is dropped per docs/design/capture-skill-consolidation.md §b). Used downstream to scope what feeds the SOD/EOD state doc (ADR-013).",
		),
	surface: z
		.string()
		.optional()
		.describe(
			`The app/agent/ingest path this capture came through, e.g. 'claude_code', 'gmail_ingest' (open vocab, see vocab.ts SURFACES). Finer than source_channel; used to derive trust and synthesis role at read time (ADR-026, ADR-046 §3). Falls back to the user's default_surface, then to '${ARTIFACT_SURFACES.api}' — never null, since a null surface is a row no role/trust map entry can address (#584). Declare it whenever you know it: the floor is honest, not informative.`,
		),
	trust_override: trustTier
		.optional()
		.describe(
			"Optional explicit trust tier for THIS capture, overriding the value normally derived from its surface (e.g. a low-trust forward arriving on a trusted surface). One of: perfect|high|medium|low|unverified (ADR-026).",
		),
	captured_by: z
		.string()
		.optional()
		.describe("The actor that captured this (e.g. 'user', or an automation name). Not the surface."),
	urgency: urgencyLevel
		.optional()
		.describe(
			"Optional user-supplied urgency dial for THIS capture: 'throw' (fire-and-forget), 'default', or 'file' (the user flagged it as needing fuller downstream handling). Written faithfully and NEVER acted on at capture time — the enrich consumer (#52) reads it to decide how much to do (ADR-018). Set only from an explicit user signal (e.g. a '-throw'/'-file' flag), never inferred from content.",
		),
	captured_at: z
		.string()
		.optional()
		.describe(
			"Optional ISO timestamp (or 'YYYY-MM-DD') declaring the day this content is ABOUT, when that differs from now. Defaults to now. Two hard bounds, both refusals rather than silent fallbacks: a future value is rejected, and it is honoured only for content_subtype in [daily_log] — today just the Daily Log twin (#562), whose day is fixed by the entry it mirrors and is up to seven days before write time when the unattended sweep (#561) writes it. This is a caller DECLARATION about its own artifact, not capture inferring a date; an unbounded dial would let any caller misfile atoms into arbitrary day buckets (#414). See #571 for whether a general originated_at should exist instead.",
		),
	dedup_key: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional caller-supplied idempotency key (#993), scoped to the caller's user_id, same shape as create_external_link's dedup_key. A second capture with the same dedup_key returns the FIRST artifact's id with deduplicated: true instead of inserting a new row — enforced race-safely by a real unique index, unlike the default content-fingerprint dedup below. Use this when the caller already has a stable identity for what it's submitting (e.g. re-posting the same webhook payload); leave it unset to fall back on the default fingerprint+window guard.",
		),
	processing_metadata: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Optional structured processing metadata stored in the processing_metadata column (e.g. { pillars: [...] } on a Daily Log twin, #657).",
		),
};

export const captureSchema = z.object(captureInput);
export type CaptureInput = z.infer<typeof captureSchema>;

export const documentDuplicatesInput = {
	query: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Title filter (case-insensitive substring). Reports the clusters a matching title belongs to, whole: a renamed identical copy or a differently dated version is still listed.",
		),
	connector: z
		.string()
		.regex(/^[a-z_]+$/, "lowercase letters and underscores only, as discover's connector names")
		.optional()
		.describe("Only pointers discovered from this connector, e.g. 'gdrive', 'gdrive_work' or 'notion'."),
	min_cluster: z
		.number()
		.int()
		.min(2)
		.max(1000)
		.optional()
		.describe("Smallest cluster to report (default 2)."),
	limit: z.number().int().min(1).max(50).optional().describe("Max clusters, largest first (default 20)."),
	include_archived: z
		.boolean()
		.optional()
		.describe("Count archived (soft-deleted) pointers as members too. Defaults to false."),
};

export const documentDuplicatesSchema = z.object(documentDuplicatesInput);
export type DocumentDuplicatesInput = z.infer<typeof documentDuplicatesSchema>;

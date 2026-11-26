// Shared Daily Log & State Doc link/subtype vocabulary (ADR-050 §6, ADR-051 §10, #562, #666, #1604).
// Kept out of tools/capture.ts so the pure reader (externalLinks.ts) and the writer share one
// definition without either importing the MCP server's tool-registration surface.

/** `artifacts.content_subtype` on the twin row `daily_log_create` captures (#562). */
export const DAILY_LOG_CONTENT_SUBTYPE = "daily_log" as const;

/** `artifact_external_links.kind` on the twin → Notion Daily Log page pointer (#562). */
export const DAILY_LOG_LINK_KIND = "daily_log" as const;

/** `artifact_external_links.kind` on the hop-2 marker: Daily Log twin → State Doc page (#666, ADR-050 §6). */
export const STATE_DOC_LINK_KIND = "consumed_by_state" as const;

/** `artifacts.content_subtype` on the weekly KPI scorecard row `weekly_kpi_snapshot` captures (ADR-115, ADR-046 §3). */
export const WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE = "weekly_kpi_scorecard" as const;

/** `artifacts.content_subtype` on the daily email flow scorecard row (`Starting`, `New Today`, `Processed`, `End` per inbox and combined; ADR-052, ADR-110). */
export const DAILY_EMAIL_FLOW_CONTENT_SUBTYPE = "daily_email_flow_scorecard" as const;

/** `artifacts.content_subtype` on scheduled-task ritual scaffolds (`#994`, ADR-051 §9). */
export const SCAFFOLD_CONTENT_SUBTYPE = "scaffold" as const;

/** `artifacts.content_subtype` on reflection rows written via `daily_log_create` (#2316). */
export const REFLECTION_CONTENT_SUBTYPE = "reflection" as const;

/** `artifact_external_links.kind` on the reflection twin → Notion Daily Log page pointer (#2316). */
export const REFLECTION_LINK_KIND = "reflection" as const;

/** `artifacts.content_subtype` on auto-captured task request provenance artifacts (#413). */
export const TASK_REQUEST_CONTENT_SUBTYPE = "task_request" as const;

/** Alias of {@link TASK_REQUEST_CONTENT_SUBTYPE} for act_receipt readers (#2225). */
export const TASK_CREATE_RECEIPT_SUBTYPE = TASK_REQUEST_CONTENT_SUBTYPE;

/** `artifacts.content_subtype` on auto-captured event request provenance artifacts (#126). */
export const EVENT_REQUEST_CONTENT_SUBTYPE = "event_request" as const;

/** `artifacts.content_subtype` on `ingest_meeting_notes` Drive-doc and email-body captures (#873). */
export const MEETING_NOTE_CONTENT_SUBTYPE = "meeting-note" as const;

/** The `content_subtype` values a caller may declare a `captured_at` for on `capture` (#562, #1658, #2316). */
export const BACKDATABLE_CONTENT_SUBTYPES: ReadonlySet<string> = new Set([
	DAILY_LOG_CONTENT_SUBTYPE,
	REFLECTION_CONTENT_SUBTYPE,
]);

/** `content_subtype` values that mark a capture as system-produced and skip fingerprint dedup (#993, #1124, #1658, #2316). */
export const SYSTEM_PRODUCED_CONTENT_SUBTYPES: ReadonlySet<string> = new Set([
	TASK_REQUEST_CONTENT_SUBTYPE,
	EVENT_REQUEST_CONTENT_SUBTYPE,
	DAILY_LOG_CONTENT_SUBTYPE,
	MEETING_NOTE_CONTENT_SUBTYPE,
	SCAFFOLD_CONTENT_SUBTYPE,
	REFLECTION_CONTENT_SUBTYPE,
]);

/** Discover & Index pointer stages that have no body content and must not count as synthesis material (`#567`). */
export const UNENRICHED_ARTIFACT_STAGES: ReadonlySet<string> = new Set([
	"discovered",
	"failed",
]);

/**
 * The Synthesize step completed **with the human in the loop** — read,
 * corrected, confirmed (ADR-050 §6, #560, #1539).
 */
export const SYNTHESIZED = "synthesized" as const;

/**
 * A fallback sweep produced a draft **that no human has confirmed**
 * (ADR-050 §8, #561, #1539).
 */
export const SYNTHESIZED_UNATTENDED = "synthesized_unattended" as const;

/**
 * The kind a newly-written Synthesize marker carries.
 */
export const SYNTHESIS_MARKER_WRITE_KIND = SYNTHESIZED;

/**
 * Every `kind` that means "this atom has been through the Synthesize step"
 * (ADR-050 §6, #560, #1539).
 *
 * Kept as a local copy in `@ahkms/core` so `@ahkms/core` stays isomorphic
 * (`scripts/check-core-isomorphic.js`); parity against `@ahkms/shared` is
 * pinned by test in `@ahkms/mcp-server`.
 */
export const SYNTHESIS_MARKER_KINDS = [
	SYNTHESIZED,
	SYNTHESIZED_UNATTENDED,
] as const;

export type SynthesisMarkerKind = (typeof SYNTHESIS_MARKER_KINDS)[number];

/**
 * The day's evidence aggregate closed **with the human in the loop** on the
 * Daily Log twin (ADR-108 §5, ADR-109 §1-§2, #2225).
 */
export const EVIDENCE_AGGREGATED = "evidence_aggregated" as const;

/**
 * The unattended fallback sweep closed the day's evidence aggregate on the
 * Daily Log twin without human confirmation (ADR-108 §5, ADR-109 §1-§2, #2225).
 */
export const EVIDENCE_AGGREGATED_UNATTENDED = "evidence_aggregated_unattended" as const;

/**
 * Every `kind` stamped on a Daily Log twin to close a day's evidence aggregate.
 * Kept outside {@link SYNTHESIS_MARKER_KINDS} so per-atom `not_consumed` reads
 * and `getSynthesizedArtifactIds` remain untouched (ADR-108 §5, #2225).
 */
export const EVIDENCE_CLOSING_KINDS = [
	EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED,
] as const;

export type EvidenceClosingKind = (typeof EVIDENCE_CLOSING_KINDS)[number];

/**
 * entity_relationships.relationship_type open vocabulary (#1482, ADR-021, ADR-033, ADR-035, ADR-099).
 * Canonical people<->people terms live in RELATIONSHIP_VOCABULARY; these system and general-purpose
 * edge types pass through resolveRelationshipType unchanged.
 */
export const EDGE_TYPES = [
	"belongs_to",
	"associated_with",
	"related_to",
	"mentions",
	"depends_on",
	"supersedes",
	"knows",
	"works_with",
	"member_of",
	"employed_by",
	"about",
	"located_at",
	"attended",
	"met_at",
	"derived_from",
	"co_occurs_with",
	"engaged_to",
	"married_to",
	"partner_of",
	"vendor_for",
	"client_of",
	"author",
	"is_part_of",
	"has_part",
	"subject_of",
	"was_generated_by",
	"was_attributed_to",
	"references",
	"is_referenced_by",
	"current_project",
	"broader",
	"narrower",
	"skos_related",
	"employer",
	"employee",
	"resident",
	"at_place",
	"supplier",
	"customer",
	"of_utility",
	"knows_about",
	"demonstrates",
	"in_role",
	"student",
	"institution",
	// Job-application arrangement participant edges (ADR-120, #2439; ahos:-native per ADR-033):
	"applicant", // nearest: schema:agent on schema:ApplyAction (not an arrangement); minted ahos:applicant
	"applied_to", // nearest: schema:hiringOrganization on schema:JobPosting (not an application); minted ahos:appliedTo
	"applied_via", // nearest: schema:instrument on schema:Action (not an arrangement participant); minted ahos:appliedVia
	"recruiter", // nearest: schema:participant / schema:agent (loses recruiter role); minted ahos:recruiter
	"hiring_contact", // nearest: schema:contactPoint (range ContactPoint, not Person); minted ahos:hiringContact
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];


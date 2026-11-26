// ---------------------------------------------------------------------------
// Synthesis marker vocabulary (ADR-050 §6, #560)
//
// The Synthesize step records consumption as a positive lineage row in
// `artifact_external_links` (ADR-013 §7): presence = consumed, absence =
// not-yet-consumed. `kind` names the STEP; `external_id` names the OBJECT.
//
// `kind` is free `text` with no CHECK constraint, so this vocabulary is enforced
// here rather than in the schema, and `UNIQUE (artifact_id, provider, kind,
// external_id)` keeps every marker idempotent regardless of which name is used.
// ---------------------------------------------------------------------------

/**
 * The Synthesize step completed **with the human in the loop** — read,
 * corrected, confirmed. This is the only kind new code writes.
 */
export const SYNTHESIZED = 'synthesized' as const;

/**
 * A fallback sweep produced a draft **that no human has confirmed**
 * (ADR-050 §8). Reserved by this vocabulary; the sweep that emits it is #561.
 */
export const SYNTHESIZED_UNATTENDED = 'synthesized_unattended' as const;


/**
 * The kind a newly-written Synthesize marker carries.
 *
 * Write one; read {@link SYNTHESIS_MARKER_KINDS}.
 */
export const SYNTHESIS_MARKER_WRITE_KIND = SYNTHESIZED;

/**
 * Every `kind` that means "this atom has been through the Synthesize step".
 *
 * ADR-050 §6 is explicit that the `not_consumed` predicate must match **any**
 * synthesis kind, never a single name — "left unchanged, swept atoms would keep
 * presenting as unconsumed forever, the exact pile the fallback exists to
 * prevent". That is why this stays a set even now that the legacy name is gone:
 * #561's unattended sweep writes `synthesized_unattended`, and an atom it swept
 * must not come back round as unconsumed. The same set answers "did the ritual
 * run" for the alert evaluator.
 */
export const SYNTHESIS_MARKER_KINDS = [
  SYNTHESIZED,
  SYNTHESIZED_UNATTENDED,
] as const;

export type SynthesisMarkerKind = (typeof SYNTHESIS_MARKER_KINDS)[number];

/**
 * The day's evidence aggregate closed **with the human in the loop** on the
 * Daily Log twin (ADR-108 §5, ADR-109 §1-§2).
 */
export const EVIDENCE_AGGREGATED = 'evidence_aggregated' as const;

/**
 * The unattended fallback sweep closed the day's evidence aggregate on the
 * Daily Log twin without human confirmation (ADR-108 §5, ADR-109 §1-§2).
 */
export const EVIDENCE_AGGREGATED_UNATTENDED = 'evidence_aggregated_unattended' as const;

/**
 * Every `kind` stamped on a Daily Log twin to close a day's evidence aggregate.
 * Kept outside {@link SYNTHESIS_MARKER_KINDS} so `not_consumed` reads and
 * `getSynthesizedArtifactIds` stay scoped to per-atom narrative markers (ADR-108 §5).
 */
export const EVIDENCE_CLOSING_KINDS = [
  EVIDENCE_AGGREGATED,
  EVIDENCE_AGGREGATED_UNATTENDED,
] as const;

export type EvidenceClosingKind = (typeof EVIDENCE_CLOSING_KINDS)[number];

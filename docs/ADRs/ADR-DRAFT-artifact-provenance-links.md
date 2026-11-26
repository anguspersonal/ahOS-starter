# ADR-DRAFT: Artifact provenance realized as metadata, not relational edges

**Status:** Proposed (draft — integer minted at merge per the ADR README's mint-at-merge rule)
**Created:** 2026-07-07
**Accepted-on-dev:** (pending merge)
**Refs:** #225, #193, ADR026 (Rationalised Provenance), ADR033 (External Vocabulary Adoption)

## Context

ADR033's vocabulary train adopted PROV-O lineage terms (`prov:wasDerivedFrom`,
`prov:wasGeneratedBy`, `prov:wasAttributedTo`) into the edge vocabulary
(`EDGE_TYPES` + `PROV_CONTEXT`, PR #226), but the Step 05 recording half of
issue #193 was deferred: `entity_relationships.from_entity_id`/`to_entity_id`
carry hard FKs to `entities(id)`, and derived artifacts and their sources are
`artifacts` rows, never `entities` rows. An artifact→artifact `derived_from`
edge cannot exist in `entity_relationships` without violating the FK. Issue
#225 captured three options.

## Options considered

1. **Give derived artifacts `entities` rows** so the existing entity graph can
   express lineage. Rejected: conflates two load-bearing concepts (every
   entity surface — CHECK constraint, palette, sync, graph rendering — would
   have to learn "artifact-entities"), for a traversal capability nothing
   currently consumes.
2. **A new `artifact_relationships` table** (artifact↔artifact, open vocab).
   Rejected *for now*: a second graph with no reader is speculative
   infrastructure, and a parallel edge table must be kept in sync with the
   entity graph for every cross-cutting query. This remains the escape hatch
   (below).
3. **Formalize the existing JSONB pointers as the PROV-O realization.**
   Chosen. `linkDerivedArtifact()` already writes
   `processing_metadata.derived_artifact_id` on the source, and the derived
   artifact already carries `processing_metadata.derived_from`. This option
   upgrades the derived side to a complete, structured, PROV-labeled record
   and *documents* that this is what `prov:*` means in ahkms — consistent with
   the house philosophy ("naming standard, not inference engine", ADR033; no
   reasoner; map, don't store, ADR016).

## Decision

The PROV-O lineage terms are realized as a structured `prov` block inside the
**derived artifact's** `processing_metadata`, written by Step 05
(`createDerivedArtifactRecord`, `packages/worker/src/workflows/steps/createDerived.ts`):

```jsonc
"prov": {
  "derived_from": "<source artifact id>",              // prov:wasDerivedFrom
  "was_generated_by": {                                 // prov:wasGeneratedBy (the Step-05 activity)
    "workflow_id": "<workflow id>",
    "step_id": <step id>,
    "step_type": "<step type>"
  },                                                    // null when no activity context (legacy callers)
  "was_attributed_to": "<user id>"                      // prov:wasAttributedTo (responsible agent)
}
```

Semantics the implementation must hold:

- **Who writes:** only Step 05's `createDerivedArtifactRecord`, at artifact
  creation time (the block is immutable-in-practice — it describes the birth
  of the row).
- **Keys are exactly `PROV_CONTEXT`'s `EDGE_TYPES` keys** (mcp-server
  `vocab.ts`: `derived_from`, `was_generated_by`, `was_attributed_to`), so a
  block key can be looked up in `PROV_CONTEXT` verbatim to recover its
  canonical `prov:` IRI — the vocabulary and the realization are joinable by
  key, not merely by resemblance.
- **Compatibility:** the pre-existing flat keys (`derived_from`,
  `derived_at`, `derived_type`) and the source-side
  `processing_metadata.derived_artifact_id` pointer are retained unchanged.
- **Idempotency:** the block is written once with the insert; re-processing a
  source creates a *new* derived artifact with its own block (no upsert
  semantics needed).

No migration: JSONB only, no schema change, nothing to backfill (pre-existing
derived artifacts keep their legacy flat pointers, which remain valid).

## Consequences

- Lineage is queryable per-artifact (`processing_metadata->'prov'`) but not
  graph-traversable. That is a deliberate trade matching current consumption
  (none) — display surfaces can read the block directly.
- **Escape hatch:** if a lineage consumer materializes (UI, cross-graph
  queries), option 2's `artifact_relationships` table can be introduced then,
  **backfilled entirely from these blocks** (they carry every column such a
  table would need). This ADR should be superseded at that point, not bent.
- `PROV_CONTEXT` in `vocab.ts` continues to advertise the vocabulary; this ADR
  is the answer to "where do these edges actually live?"

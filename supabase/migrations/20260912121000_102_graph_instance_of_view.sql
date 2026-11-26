-- Migration 102: graph_instance_of derived view (ADR-036 §2)
-- Issue: #359 · Refs: ADR-036 §2 (docs/ADRs/ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md)
-- Date: 2026-09-12
--
-- ADR-036 §2 — instance-level classification is DERIVED, never written. This
-- view projects one virtual edge per entity: `entity.id -> term-node.id`,
-- joining `entities.entity_type` to the vocabulary registry (migration 081's
-- term-node rows / ADR-037 §1). Nothing is written per instance; the
-- `entity_type` column stays the single source of truth -- an N-row
-- `instance_of` edge or a `layer` property on every row would duplicate it
-- and *will* drift (the exact failure mode §2 rejects).
--
-- Shape: one row per (entity, matching term-node) pair, in the SAME column
-- shape as `entity_relationships` so a caller (entity_neighbourhood's
-- include_instance_of flag, #359) can union it into an ordinary edge
-- traversal with no special-casing:
--   from_entity_id      -- the instance
--   to_entity_id        -- the term-node classifying it
--   relationship_type   -- literal 'instance_of'
--   confidence_score    -- NULL (a derived fact, not an asserted one)
--   metadata            -- NULL
--   valid_from/valid_to -- NULL (an instance's type never expires)
--
-- Only the instance -> term-node FIRST hop is virtual (this view); everything
-- onward -- a term-node's exactMatch, its governed_by principle -- is real
-- rows (ADR-036 §3's "few and hand-curated" edges), reached by an ordinary
-- further traversal once the term-node is in the frontier, not by this view.
--
-- Bootstrap note (ADR-036 §1): term-node rows are themselves entity_type =
-- 'concept', so a term-node row (including the 'concept' term-node itself)
-- also gets an instance_of edge to the 'concept' term-node -- a self-loop for
-- that one row. This circularity is acknowledged in the ADR as acceptable:
-- "the same foundation every RDF store has -- something non-RDF stores the
-- triples." Namespace rows (properties.type = 'ahos_namespace', migration
-- 078) are entity_type = 'concept' too, so they classify the same way -- no
-- special-casing needed for either discriminator.
--
-- Ownership: both sides of the join are `entities` rows, so RLS on the
-- underlying table governs access, exactly as graph_terms/graph_namespaces
-- do. No new grants needed -- a plain SELECT-only view.
--
-- Idempotent: CREATE OR REPLACE VIEW; no rows written, no CHECK constraints
-- touched, no function signatures changed (check-migration-signatures
-- unaffected). Re-running `supabase db push` is a no-op.

BEGIN;

CREATE OR REPLACE VIEW public.graph_instance_of AS
  SELECT
    e.id                 AS from_entity_id,
    t.id                 AS to_entity_id,
    'instance_of'::text  AS relationship_type,
    NULL::numeric(5,2)   AS confidence_score,
    NULL::jsonb          AS metadata,
    NULL::timestamptz    AS valid_from,
    NULL::timestamptz    AS valid_to,
    e.user_id
  FROM public.entities e
  JOIN public.entities t
    ON t.user_id = e.user_id
   AND t.properties ->> 'type' = 'ahos_concept_term'
   AND t.properties ->> 'applies_to' = 'entity_type'
   AND t.properties ->> 'term' = e.entity_type;

COMMENT ON VIEW public.graph_instance_of IS
  'ADR-036 §2: derived instance_of projection. One virtual edge per entity, joining entities.entity_type to its term-node (properties.type=''ahos_concept_term'', properties.applies_to=''entity_type'', properties.term=entities.entity_type). Never written -- entity_type stays the single source of truth. Shaped like entity_relationships (from_entity_id/to_entity_id/relationship_type/confidence_score/metadata/valid_from/valid_to) so entity_neighbourhood can union it in via its opt-in include_instance_of flag (#359).';

COMMIT;

-- Migration complete: graph_instance_of view. No rows written, no schema
-- changes to entities/entity_relationships, no CHECK/constraint changes.

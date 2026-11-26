-- Migration 081: term-node row shape + graph_terms view (ADR-037 §1)
-- Issue: #453 · Refs: ADR-037 §1/§4/§5 (docs/ADRs/ADR037_IRI_Storage_Local_Name_And_Namespace_Binding.md)
-- Date: 2026-08-05
--
-- ADR-037 §1 — how a term-node stores its canonical IRI. A term row carries
-- only the STABLE parts:
--   local_name -- the IRI local part ('People', 'employed_at'), stored
--                 explicitly (runtime `term` and the local part diverge for
--                 classes: 'people' -> People; casing rules drift)
--   namespace  -- OPTIONAL pointer to a namespace row (migration 078 / #452),
--                 by the namespace's STABLE identity — its namespace_iri or its
--                 row id — NEVER the mutable prefix. Omitted => default 'ahos'.
--                 STORAGE is currently restricted to the namespace_iri form
--                 only (guard 1(d), QA round-1 fix #545) — the row-id form
--                 stays reserved (readable by graph_terms, not yet writable)
--                 until a writer needs it, so the unique index in guard 1(a)
--                 can safely dedupe on the raw pointer string.
--
-- The stored `iri` CURIE property sketched in ADR-036 §1a is REMOVED (#453):
-- `iri` (full) = namespace_iri || local_name and `curie` = prefix || ':' ||
-- local_name are PROJECTIONS derived at read/export time, never persisted.
-- Hence a prefix rename ('ahos' -> 'ah') or a namespace re-host is a ONE-ROW
-- edit on the namespace row — zero term rows touched.
--
-- Shape: a term-node is an `entities` row reusing entity_type = 'concept' with
-- the discriminator properties.type = 'ahos_concept_term' (ADR-036 §1; NO new
-- CHECK value — 'concept' shipped in migration 065 / ADR-033). `term` (the
-- runtime entity_type/edge_type join key) is unchanged; the entity_type column
-- remains the bootstrap primitive.
--
-- Ownership: term rows are ego-owned (KMS_USER_ID), exactly like the namespace
-- rows — NOT a global vocabulary layer (see the #453 ownership-precedent
-- comment; migrations 075/078 set the pattern). RLS inherited from entities.
--
-- No seed: this migration defines shape + guards + the derived read path. The
-- rows themselves land via seed ingestion (#326).
--
-- Idempotent & reconciliation-safe: CREATE OR REPLACE VIEW, CREATE INDEX IF
-- NOT EXISTS, constraint added only if absent — re-running `supabase db push`
-- is a no-op. No function signatures are touched (check-migration-signatures
-- unaffected).

BEGIN;

-- 1. Integrity guards (ADR-037 §5 discipline gates), scoped to term rows so
--    they never touch other 'concept' entities (mirrors migration 078's style).

--    (a) The derived IRI is an identity: one term row per (owner, namespace,
--        local_name). COALESCE folds the omitted-default pointer into '' so
--        two default-namespace rows can't share a local_name either.
CREATE UNIQUE INDEX IF NOT EXISTS graph_terms_namespace_local_name_uniq
  ON public.entities (user_id, COALESCE(properties ->> 'namespace', ''), (properties ->> 'local_name'))
  WHERE properties ->> 'type' = 'ahos_concept_term';

--    (b) `term` is the runtime join key to the entity_type/edge_type primitive
--        — one grounding row per runtime string per owner.
CREATE UNIQUE INDEX IF NOT EXISTS graph_terms_term_uniq
  ON public.entities (user_id, (properties ->> 'term'))
  WHERE properties ->> 'type' = 'ahos_concept_term';

--    (c) ADR-037 §5: no term row may STORE a literal iri/curie — both are
--        derived. DB-level backstop for the #455 CI vocab diff. Scoped by the
--        discriminator, so every non-term row passes trivially; validation at
--        ADD time is trivial too (no ahos_concept_term rows exist before #326
--        seeds them). Guarded for idempotence (ADD CONSTRAINT has no IF NOT
--        EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entities_term_node_no_stored_iri'
      AND conrelid = 'public.entities'::regclass
  ) THEN
    ALTER TABLE public.entities
      ADD CONSTRAINT entities_term_node_no_stored_iri
      CHECK (
        properties ->> 'type' IS DISTINCT FROM 'ahos_concept_term'
        OR NOT (properties ?| ARRAY['iri', 'curie'])
      );
  END IF;
END $$;

--    (d) QA round 1 (#545) fix: guard (a)'s unique index dedupes on the RAW
--        pointer STRING, but graph_terms (below) resolves a pointer via
--        EITHER the namespace_iri form OR the namespace row's id form —
--        two different literal strings can legally name the same namespace
--        (ADR-037 §2 permits both as "stable identity"). Two term rows
--        pointing at the same namespace via different pointer forms, same
--        local_name, would collide in graph_terms' derived iri/curie without
--        tripping the unique index. The TS writer (buildTermNodeProperties)
--        only ever emits the namespace_iri form today, so this CHECK simply
--        makes that the only form the DB will accept — the row-id branch in
--        graph_terms' JOIN stays as forward-compatible dead code, reserved
--        until a writer actually needs it (at which point the unique index
--        must be revisited to dedupe on RESOLVED namespace identity, not the
--        raw pointer string). IRI form is identified by the URI scheme
--        separator '://', which no namespace row id (uuid) can contain.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entities_term_node_namespace_pointer_iri_form'
      AND conrelid = 'public.entities'::regclass
  ) THEN
    ALTER TABLE public.entities
      ADD CONSTRAINT entities_term_node_namespace_pointer_iri_form
      CHECK (
        properties ->> 'type' IS DISTINCT FROM 'ahos_concept_term'
        OR properties ->> 'namespace' IS NULL
        OR properties ->> 'namespace' LIKE '%://%'
      );
  END IF;
END $$;

-- 2. graph_terms — the derived term read path (ADR-037 §1). Joins each term
--    row to its namespace row (migration 078) and computes the projections:
--      iri   = namespace_iri || local_name
--      curie = prefix || ':' || local_name
--    Pointer resolution accepts BOTH stable-identity forms (namespace_iri or
--    the namespace row's id) and falls back to the owner's is_default row
--    ('ahos') when the pointer is omitted — the derived-default fast path.
--    NOTE (#545 fix, guard 1(d) above): the row-id branch is reserved for a
--    future writer — the guard above currently only lets namespace_iri-form
--    pointers be STORED, so this branch is unreachable until that CHECK is
--    loosened for a specific writer that needs it.
--    LEFT JOIN deliberately: a term whose pointer resolves to no namespace row
--    stays VISIBLE with NULL iri/curie (queryable violation of the §5 gate),
--    rather than silently vanishing from the view.
--    RLS on the underlying entities table governs access (mirrors
--    graph_namespaces / capabilities views).
CREATE OR REPLACE VIEW public.graph_terms AS
  SELECT
    t.id,
    t.user_id,
    (t.properties ->> 'term')       AS term,
    (t.properties ->> 'local_name') AS local_name,
    (t.properties ->> 'namespace')  AS namespace_pointer,
    ns.prefix,
    ns.namespace_iri,
    (ns.namespace_iri || (t.properties ->> 'local_name'))  AS iri,
    (ns.prefix || ':' || (t.properties ->> 'local_name'))  AS curie,
    (t.properties ->> 'applies_to') AS applies_to,
    t.created_at,
    t.updated_at
  FROM public.entities t
  LEFT JOIN public.graph_namespaces ns
    ON ns.user_id = t.user_id
   AND CASE
         WHEN t.properties ? 'namespace' THEN
           ns.namespace_iri = t.properties ->> 'namespace'
           OR ns.id::text = t.properties ->> 'namespace'
         ELSE ns.is_default
       END
  WHERE t.properties ->> 'type' = 'ahos_concept_term';

COMMENT ON VIEW public.graph_terms IS
  'ADR-037 §1 (#453): derived term-node read path. Rows are entities where properties.type=''ahos_concept_term'' (entity_type=''concept''). iri and curie are PROJECTIONS (namespace_iri||local_name, prefix||'':''||local_name) joined from graph_namespaces — never stored. NULL iri/curie = unresolvable namespace pointer (ADR-037 §5 gate violation).';

COMMIT;

-- Migration complete: term-row integrity indexes + no-stored-iri CHECK +
-- namespace-pointer-iri-form CHECK (#545 round-1 fix) + graph_terms derived
-- view. No rows written — seed ingestion is #326.

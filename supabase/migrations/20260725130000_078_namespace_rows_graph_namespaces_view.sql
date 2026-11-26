-- Migration 078: namespace rows + graph_namespaces view (ADR-037 §2)
-- Issue: #452 · Refs: ADR-037 §2 (docs/ADRs/ADR037_IRI_Storage_Local_Name_And_Namespace_Binding.md)
-- Date: 2026-07-25
--
-- ADR-037 §2 — the namespace binding primitive that the whole IRI-storage model
-- rests on. A CURIE (`ahos:People`) is `prefix : local`: a MUTABLE presentation
-- prefix glued to a STABLE local name. We store the binding ONCE, on a namespace
-- row, so a prefix rename (`ahos` -> `ah`) or a namespace re-host is a ONE-ROW
-- edit, never an N-row migration.
--
-- Shape: a namespace is an `entities` row reusing entity_type = 'concept' with the
-- discriminator properties.type = 'ahos_namespace' (mirrors 'ahos_concept_term';
-- NO new CHECK value — 'concept' shipped in migration 065 / ADR-033). Each row
-- carries LITERAL properties, read directly and never IRI-resolved:
--   prefix        -- 'ahos', 'foaf', 'schema', … the presentation label (mutable)
--   namespace_iri -- the full namespace IRI, the namespace's stable identity
--   is_default    -- true for exactly one row ('ahos'); lets term rows omit the pointer
--
-- graph_namespaces is the derived prefix->IRI map consumed by ingestion and
-- export_rdf (#454). It is the ADR's bootstrap floor: resolved by reading
-- literals, exactly as ADR-036 bottoms out at the entity_type column.
--
-- Ownership: like every entities row, namespace rows are owner-scoped. This is an
-- ego-centric, single-owner graph — the MCP server runs as one KMS_USER_ID and
-- filters every read by it — so the ~9 vocabulary rows are owned by that user,
-- exactly as migration 075 seeds the 'domain' rows. RLS is inherited from the
-- entities table; graph_namespaces is public standards data, no privacy concern.
--
-- Idempotent & reconciliation-safe: CREATE OR REPLACE VIEW, CREATE INDEX IF NOT
-- EXISTS, and a seed that inserts a namespace only when its (owner, prefix) is
-- absent — re-running `supabase db push` is a no-op.
--
-- The seeded set mirrors the @prefix block of the authoritative seed graph
-- ahOS-seed.ttl (v2, pyoxigraph-validated) and the canonical registry
-- AHOS_NAMESPACES in @ahkms/shared (packages/shared/src/constants/namespaces.ts).
-- Keep the three in lockstep — the CI vocab diff (#455) will assert it.
-- 'ahos' and 'schema' are HTTPS, per ADR-037's canonical IRIs.

BEGIN;

-- 1. Integrity guards (ADR-037 §5 discipline gates), scoped to namespace rows so
--    they never touch other 'concept' entities.
--    (a) One namespace per prefix per owner — also makes the seed's
--        insert-if-absent guard a hard invariant.
CREATE UNIQUE INDEX IF NOT EXISTS graph_namespaces_prefix_uniq
  ON public.entities (user_id, (properties ->> 'prefix'))
  WHERE properties ->> 'type' = 'ahos_namespace';

--    (b) At most one default namespace per owner ("exactly one" once 'ahos' is
--        seeded). Compares the extracted text to 'true' (a jsonb boolean renders
--        as the text 'true' via ->>) — immutable, index-predicate safe.
CREATE UNIQUE INDEX IF NOT EXISTS graph_namespaces_one_default
  ON public.entities (user_id)
  WHERE properties ->> 'type' = 'ahos_namespace'
    AND properties ->> 'is_default' = 'true';

-- 2. graph_namespaces — the derived prefix->IRI map (ADR-037 §2). A flat literal
--    read over one table; no recursion, no graph walk. Mirrors the capabilities
--    view (migration 056): typed properties surfaced as columns, ownership +
--    timestamps preserved, RLS on the underlying entities table governs access.
--    (~9 rows; a plain view is ample. Materialize only if export_rdf turns hot —
--    ADR-037 flags this as a deferrable cost mitigation, not a v1 need.)
CREATE OR REPLACE VIEW public.graph_namespaces AS
  SELECT
    id,
    user_id,
    (properties ->> 'prefix')        AS prefix,
    (properties ->> 'namespace_iri') AS namespace_iri,
    COALESCE((properties ->> 'is_default')::boolean, false) AS is_default,
    created_at,
    updated_at
  FROM public.entities
  WHERE properties ->> 'type' = 'ahos_namespace';

COMMENT ON VIEW public.graph_namespaces IS
  'ADR-037 §2: derived prefix->IRI binding map. Rows are entities where properties.type=''ahos_namespace'' (entity_type=''concept''). The bootstrap floor — read as literals, never IRI-resolved. Consumed by ingestion and export_rdf (@prefix headers).';

-- 3. Seed the initial bindings (owner-scoped). Mirrors migration 075's domain
--    seed: resolve the single KMS owner, then insert each namespace only if its
--    (owner, prefix) is absent. Migrations run against prod via `supabase db
--    push` (never a fresh CI DB), so the owner always exists at apply time.
DO $$
DECLARE
  v_user_id uuid;
  r         RECORD;
BEGIN
  -- The single KMS owner (KMS_USER_ID at runtime), same lookup as migration 075.
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'owner@example.com';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION
      'Seed aborted: no auth.users row for owner@example.com. Set the email to the KMS owner''s auth user and re-run.';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('ahos',   'https://example.com/ahos-ontology#',            true),
      ('rdf',    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',      false),
      ('rdfs',   'http://www.w3.org/2000/01/rdf-schema#',            false),
      ('owl',    'http://www.w3.org/2002/07/owl#',                   false),
      ('skos',   'http://www.w3.org/2004/02/skos/core#',             false),
      ('schema', 'https://schema.org/',                              false),
      ('foaf',   'http://xmlns.com/foaf/0.1/',                       false),
      ('rel',    'http://purl.org/vocab/relationship/',              false),
      ('xsd',    'http://www.w3.org/2001/XMLSchema#',                false)
    ) AS t(prefix, namespace_iri, is_default)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.entities
      WHERE user_id = v_user_id
        AND properties ->> 'type' = 'ahos_namespace'
        AND properties ->> 'prefix' = r.prefix
    ) THEN
      INSERT INTO public.entities (id, user_id, entity_type, title, description, properties, tags)
      VALUES (
        gen_random_uuid(),
        v_user_id,
        'concept',
        r.prefix,
        format('Namespace binding %s: <%s> (ADR-037 §2).', r.prefix, r.namespace_iri),
        jsonb_build_object(
          'type',          'ahos_namespace',
          'prefix',        r.prefix,
          'namespace_iri', r.namespace_iri,
          'is_default',    r.is_default
        ),
        ARRAY[]::text[]
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Migration complete: graph_namespaces view + integrity indexes, and 9 owner-scoped
-- namespace rows (ahos default + rdf, rdfs, owl, skos, schema, foaf, rel, xsd).

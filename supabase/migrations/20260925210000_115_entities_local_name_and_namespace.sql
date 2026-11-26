-- Migration 115: entities.local_name + namespace columns — one home for IRI identity
-- Issue: #1104 · Refs: ADR-037 (docs/ADRs/ADR037_IRI_Storage_Local_Name_And_Namespace_Binding.md), #326 grill decision 1
-- Date: 2026-09-25
--
-- ADR-037 / #326: Seeded instance nodes and vocabulary term rows get a real
-- `local_name` and `namespace` column on `entities`.
--
-- Why columns and not JSONB:
--   1. DB-enforced uniqueness on the one thing that must be unique: (user_id, namespace, local_name).
--      JSONB keys cannot enforce cross-table uniqueness or be indexed without expression indexes.
--   2. Direct indexed lookups on local_name without scanning JSONB (mirroring migration 077's source_url pattern).
--   3. One home for IRI identity: local_name and namespace are removed from JSONB properties during backfill.
--
-- Default namespace:
--   ADR-037 §1 derived-default: namespace NULL means default 'ahos'.
--   Partial unique index on (user_id, COALESCE(namespace, 'ahos'), local_name) WHERE local_name IS NOT NULL
--   ensures that two rows with NULL namespace cannot share the same local_name.
--
-- Backfill:
--   Populates local_name and namespace from properties for all rows carrying them,
--   then removes 'local_name' and 'namespace' keys from properties.
--
-- Views:
--   - public.graph_terms: updated to project t.local_name and t.namespace from columns instead of properties.
--   - public.people: updated to project local_name and namespace columns.
--
-- Integrity guard carried forward (QA round 1, #1171):
--   Migration 081's `entities_term_node_namespace_pointer_iri_form` CHECK validated
--   `properties->>'namespace'`. The backfill above empties that JSONB key for every
--   row, which would make the old guard a permanent no-op — it always sees NULL and
--   passes regardless of what the new `namespace` column holds. This migration drops
--   that stale guard and adds the equivalent CHECK on the `namespace` column so a
--   non-IRI-form pointer (e.g. a bare prefix like 'foaf') is still rejected at write
--   time for term-node rows.

SET statement_timeout = '120s';

-- 1. Add columns to entities table
ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS local_name text,
  ADD COLUMN IF NOT EXISTS namespace text;

COMMENT ON COLUMN public.entities.local_name IS
  'ADR-037 §1 / #1104: IRI local part (e.g. ''People'', ''employed_at'', ''angus''). Real column providing DB-enforced identity for seeded instance nodes and vocabulary terms. Unique per (user_id, COALESCE(namespace, ''ahos''), local_name) where local_name IS NOT NULL. Single home for IRI identity — not stored in JSONB properties.';

COMMENT ON COLUMN public.entities.namespace IS
  'ADR-037 §1 / #1104: Namespace pointer for IRI identity. Identifies the namespace row (by namespace_iri or prefix). NULL indicates the default ''ahos'' namespace (derived-default rule). Single home for IRI identity — not stored in JSONB properties.';

-- 2. Backfill existing rows carrying local_name or namespace in properties
UPDATE public.entities
   SET local_name = properties->>'local_name',
       namespace = properties->>'namespace',
       properties = properties - 'local_name' - 'namespace'
 WHERE properties ? 'local_name' OR properties ? 'namespace';

-- 3. Partial unique index enforcing unique IRI identity per user
-- Drop obsolete JSONB index from migration 081 if it exists
DROP INDEX IF EXISTS public.graph_terms_namespace_local_name_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS entities_user_namespace_local_name_unique
  ON public.entities (user_id, COALESCE(namespace, 'ahos'), local_name)
  WHERE local_name IS NOT NULL;

-- Index for fast local_name lookup regardless of namespace
CREATE INDEX IF NOT EXISTS entities_user_local_name_idx
  ON public.entities (user_id, local_name)
  WHERE local_name IS NOT NULL;

-- 4. Carry migration 081's namespace-pointer-form guard onto the real column
--    (QA round 1, #1171 — see the header comment above). The old guard checked
--    `properties->>'namespace'`, which step 2's backfill just emptied for every
--    row, so it is dropped here as dead weight and replaced with the same
--    rule scoped to the `namespace` column.
ALTER TABLE public.entities
  DROP CONSTRAINT IF EXISTS entities_term_node_namespace_pointer_iri_form;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entities_term_node_namespace_column_iri_form'
      AND conrelid = 'public.entities'::regclass
  ) THEN
    ALTER TABLE public.entities
      ADD CONSTRAINT entities_term_node_namespace_column_iri_form
      CHECK (
        properties ->> 'type' IS DISTINCT FROM 'ahos_concept_term'
        OR namespace IS NULL
        OR namespace LIKE '%://%'
      );
  END IF;
END $$;

-- 5. Recreate graph_terms view reading from columns
CREATE OR REPLACE VIEW public.graph_terms AS
  SELECT
    t.id,
    t.user_id,
    (t.properties ->> 'term')       AS term,
    t.local_name                    AS local_name,
    t.namespace                     AS namespace_pointer,
    ns.prefix,
    ns.namespace_iri,
    (ns.namespace_iri || t.local_name)  AS iri,
    (ns.prefix || ':' || t.local_name)  AS curie,
    (t.properties ->> 'applies_to') AS applies_to,
    t.created_at,
    t.updated_at
  FROM public.entities t
  LEFT JOIN public.graph_namespaces ns
    ON ns.user_id = t.user_id
   AND CASE
         WHEN t.namespace IS NOT NULL THEN
           ns.namespace_iri = t.namespace
           OR ns.id::text = t.namespace
         ELSE ns.is_default
       END
  WHERE t.properties ->> 'type' = 'ahos_concept_term';

COMMENT ON VIEW public.graph_terms IS
  'ADR-037 §1 (#453, #1104): derived term-node read path. Rows are entities where properties.type=''ahos_concept_term'' (entity_type=''concept''). local_name and namespace are real columns on entities (#1104). iri and curie are PROJECTIONS (namespace_iri||local_name, prefix||'':''||local_name) joined from graph_namespaces — never stored. NULL iri/curie = unresolvable namespace pointer (ADR-037 §5 gate violation).';

-- 6. Recreate public.people view projecting local_name and namespace
CREATE OR REPLACE VIEW public.people AS
  SELECT id,
    title AS name,
    description AS bio,
    (properties ->> 'role'::text) AS role,
    (properties ->> 'organization'::text) AS organization,
    (properties ->> 'email'::text) AS email,
    (properties ->> 'phone'::text) AS phone,
    (properties ->> 'relationship'::text) AS relationship,
    ((properties ->> 'last_contact'::text))::timestamp with time zone AS last_contact,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at,
    source_url,
    aliases,
    hot,
    local_name,
    namespace
   FROM public.entities
  WHERE (entity_type = 'people'::text);

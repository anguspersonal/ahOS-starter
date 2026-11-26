-- Migration: bindings table + scoped (scope, name) resolution + 'domain' entity type
-- Issue: #62 (bindings table + scoped resolution)
-- ADR: ADR-019 §4 (the binding layer — a modularity split, not a privacy split)
-- Date: 2026-07-13
--
-- Builds the binding layer ADR-019 item #3 called for: a skill references a
-- resource by NAME (`{{notion.inbox_db}}`); the concrete value is defined once
-- and resolved at serve time, scoped by identity (personal / work). A binding
-- is a POINTER into an existing value (user_integrations config or an entities
-- property), never a copy, and NEVER a secret/token.
--
-- Three additive parts, in dependency order:
--   1. entity_type='domain' + two seeded rows (work, personal) — the scope axis.
--   2. user_integrations.domain_entity_id (nullable) — makes integration config
--      scope-aware without touching the notion_work/notion_personal convention.
--   3. bindings table + its bootstrap seed (notion.inbox_db for both domains).
--
-- Nothing here is a re-architecture (ADR-019's additive constraint): no store is
-- replaced, and the ~15 call sites hardcoded to the provider-suffix convention are
-- left untouched (that cleanup is a separate follow-up).

-- ---------------------------------------------------------------------------
-- 1. New entity_type: 'domain'
-- ---------------------------------------------------------------------------
-- Picks up the ontology's documented-but-unbuilt domain axis (ahos:Domain /
-- ahos:hasDomain in ahOS-seed.ttl) for the ONE case bindings needs — a scope to
-- resolve against — not a general domain axis on all entities. A domain is an
-- ordinary entities row: no lifecycle-protection flag, ordinary CRUD applies.
--
-- Mirrors the drop/recreate CHECK pattern from migration 067 (drop ghost types)
-- and 065 (add concept), just adding one value. Kept in sync BY HAND with
-- ENTITY_TYPES in packages/mcp-server/src/vocab.ts and GraphEntityType in
-- @ahkms/shared — update all three together. ('capability' is registry-only,
-- written via register_capability rather than the graph create_entity vocab, so
-- it is a valid DB entity_type but deliberately NOT in ENTITY_TYPES/GraphEntityType.)
--
-- ORDERING / UNION (why 11 values, not 10): this migration is timestamped
-- 20260713140000 so it applies strictly AFTER 20260713130000_074_add_capability_
-- entity_type.sql, which added 'capability'. (Originally 20260713130000_074 too —
-- the collision made this migration's schema_migrations insert fail with a
-- duplicate version and roll back atomically, so it never reached prod; renumbered
-- to 075 to break the tie.) Because add_capability runs first, the constraint we
-- DROP already includes 'capability', and prod now has 78 capability rows. So the
-- rebuilt CHECK MUST be the UNION of both additions — an ADD CONSTRAINT that
-- omitted 'capability' would revoke it AND fail re-validation against those rows.
--
-- New allowed set (11 values): the 9 pre-existing (067) + 'capability' (074) +
-- 'domain' (this migration).
--   project, area, resource, people, event, organization, signal, place,
--   concept, capability, domain
ALTER TABLE public.entities
  DROP CONSTRAINT IF EXISTS entities_entity_type_check;

ALTER TABLE public.entities
  ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'project'::text,
    'area'::text,
    'resource'::text,
    'people'::text,
    'event'::text,
    'organization'::text,
    'signal'::text,
    'place'::text,
    'concept'::text,
    'capability'::text,
    'domain'::text
  ]));

-- ---------------------------------------------------------------------------
-- 2. user_integrations.domain_entity_id (nullable, scope-aware config)
-- ---------------------------------------------------------------------------
-- NULL = domain-agnostic (covers google_drive/dex/linkedin as-is; no forced
-- domain assignment where none naturally exists). The notion_work /
-- notion_personal provider suffix convention is LEFT UNTOUCHED — this column is
-- a redundant, forward-compatible pointer backfilled onto those two rows only.
ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS domain_entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.user_integrations.domain_entity_id IS
  'Scope of this integration config (FK to an entity_type=domain row). NULL = domain-agnostic. Redundant with the notion_work/notion_personal provider convention; the resolver reads this, the send-tools still read the suffix. See ADR-019 / #62.';

-- ---------------------------------------------------------------------------
-- 3. bindings table
-- ---------------------------------------------------------------------------
-- Config/plumbing, deliberately OUTSIDE the knowledge graph so graph reads never
-- surface wiring. Not folded into user_integrations or entities: it's an
-- indirection layer whose target varies (integration config, entity property, or
-- a bare literal), not itself a connection or a graph node.
CREATE TABLE IF NOT EXISTS public.bindings (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- nullable; NULL = domain-agnostic. FK to an entity_type='domain' row.
  domain_entity_id uuid        REFERENCES public.entities(id) ON DELETE CASCADE,
  -- dotted namespace convention (e.g. notion.inbox_db). Enforced app-layer (Zod),
  -- NOT a DB constraint — a naming convention, not a structural discriminator.
  name             text        NOT NULL,
  -- STRUCTURAL discriminator: dictates target_ref's shape, so it IS a DB CHECK
  -- (follows the entity_type precedent, not the open-vocab relationship_type one).
  target_kind      text        NOT NULL CHECK (target_kind IN ('integration_config', 'entity', 'literal')),
  -- shape depends on target_kind:
  --   integration_config -> {"provider": "notion_work", "json_path": "tasks_database_id"}
  --                         (always reads user_integrations.config -> json_path; no column
  --                          selector, so credential_ref/status/routing are unreachable BY
  --                          CONSTRUCTION — the "never resolves to a secret" invariant is
  --                          structural, not a runtime check).
  --   entity             -> {"entity_id": "...", "property": "title"}  (single scalar)
  --   literal            -> {"value": "..."}  (non-secret constants only)
  target_ref       jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at       timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT bindings_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE public.bindings IS
  'Named pointers resolved at serve time by (scope, name), scoped per identity (domain_entity_id). A binding points at an existing user_integrations config value or an entities property — never copies it, never resolves to a secret/token. Plumbing, outside the knowledge graph. See ADR-019 / #62.';

-- Uniqueness via TWO partial indexes: Postgres treats NULL as distinct per-row, so
-- a plain compound unique constraint would silently allow duplicate domain-agnostic
-- names. Scoped names are unique per (user, domain); domain-agnostic names unique
-- per user.
CREATE UNIQUE INDEX IF NOT EXISTS bindings_scoped_name_uniq
  ON public.bindings (user_id, domain_entity_id, name)
  WHERE domain_entity_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bindings_global_name_uniq
  ON public.bindings (user_id, name)
  WHERE domain_entity_id IS NULL;

-- Cheap resolver lookups by (user, name).
CREATE INDEX IF NOT EXISTS idx_bindings_user_name
  ON public.bindings (user_id, name);

ALTER TABLE public.bindings ENABLE ROW LEVEL SECURITY;

-- Owner-only RLS, matching the user_integrations/entities pattern. The MCP server
-- uses the service role (bypasses RLS); these protect any RLS-bound client.
CREATE POLICY "Users can view own bindings"
ON public.bindings AS PERMISSIVE FOR SELECT TO public
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own bindings"
ON public.bindings AS PERMISSIVE FOR INSERT TO public
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own bindings"
ON public.bindings AS PERMISSIVE FOR UPDATE TO public
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own bindings"
ON public.bindings AS PERMISSIVE FOR DELETE TO public
USING (auth.uid() = user_id);

-- Keep updated_at honest on writes.
CREATE OR REPLACE FUNCTION update_bindings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_bindings_updated_at ON public.bindings;
CREATE TRIGGER update_bindings_updated_at
  BEFORE UPDATE ON public.bindings
  FOR EACH ROW
  EXECUTE FUNCTION update_bindings_updated_at();

-- ---------------------------------------------------------------------------
-- Seed: domain rows + backfill + bootstrap bindings (owner-scoped)
-- ---------------------------------------------------------------------------
-- Seeded directly here so the resolver has something to resolve on day one; every
-- binding after this goes through the create_binding tool (avoids the "new binding
-- needs a PR + db push" problem ADR-030 was written to kill).
DO $$
DECLARE
  v_user_id     uuid;
  v_work_id  uuid;
  v_personal_id uuid;
BEGIN
  -- The single KMS owner (KMS_USER_ID at runtime). VERIFIED against data ownership
  -- in migration 049: all artifacts + the user_preferences row are owned by
  -- owner@example.com, NOT the Work account. Adjust only if KMS_USER_ID changes.
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'owner@example.com';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION
      'Seed aborted: no auth.users row for owner@example.com. Set the email to the KMS owner''s auth user and re-run.';
  END IF;

  -- Two domain entities. Titles are lowercase so the resolver's case-insensitive
  -- scope match (scope='work' -> this row) is unambiguous. Idempotent: reuse an
  -- existing domain row of the same title rather than creating a duplicate.
  SELECT id INTO v_work_id
    FROM public.entities
    WHERE user_id = v_user_id AND entity_type = 'domain' AND lower(title) = 'work'
    LIMIT 1;
  IF v_work_id IS NULL THEN
    v_work_id := gen_random_uuid();
    INSERT INTO public.entities (id, user_id, entity_type, title, description, properties, tags)
    VALUES (v_work_id, v_user_id, 'domain', 'work',
            'Work work domain — the scope for Work bindings/integration config (ADR-019 / #62).',
            '{}'::jsonb, ARRAY[]::text[]);
  END IF;

  SELECT id INTO v_personal_id
    FROM public.entities
    WHERE user_id = v_user_id AND entity_type = 'domain' AND lower(title) = 'personal'
    LIMIT 1;
  IF v_personal_id IS NULL THEN
    v_personal_id := gen_random_uuid();
    INSERT INTO public.entities (id, user_id, entity_type, title, description, properties, tags)
    VALUES (v_personal_id, v_user_id, 'domain', 'personal',
            'Personal domain — the scope for personal bindings/integration config (ADR-019 / #62).',
            '{}'::jsonb, ARRAY[]::text[]);
  END IF;

  -- Backfill the scope pointer onto the two Notion rows only (redundant with the
  -- provider suffix; forward-compatible). Other providers stay domain-agnostic (NULL).
  UPDATE public.user_integrations
    SET domain_entity_id = v_work_id
    WHERE user_id = v_user_id AND provider = 'notion_work';
  UPDATE public.user_integrations
    SET domain_entity_id = v_personal_id
    WHERE user_id = v_user_id AND provider = 'notion_personal';

  -- Bootstrap binding: notion.inbox_db, resolved per scope. There is no dedicated
  -- "inbox" key in the Notion config yet, so this points at tasks_database_id — the
  -- closest existing "where captured work lands" pointer, present and NON-SECRET in
  -- BOTH workspaces, resolving to a DIFFERENT real id per scope (the whole point of
  -- scoped resolution). Repoint via update_binding once a dedicated inbox key exists.
  INSERT INTO public.bindings (user_id, domain_entity_id, name, target_kind, target_ref)
  VALUES (
    v_user_id, v_work_id, 'notion.inbox_db', 'integration_config',
    jsonb_build_object('provider', 'notion_work', 'json_path', 'tasks_database_id')
  )
  ON CONFLICT (user_id, domain_entity_id, name) WHERE domain_entity_id IS NOT NULL DO NOTHING;

  INSERT INTO public.bindings (user_id, domain_entity_id, name, target_kind, target_ref)
  VALUES (
    v_user_id, v_personal_id, 'notion.inbox_db', 'integration_config',
    jsonb_build_object('provider', 'notion_personal', 'json_path', 'tasks_database_id')
  )
  ON CONFLICT (user_id, domain_entity_id, name) WHERE domain_entity_id IS NOT NULL DO NOTHING;
END $$;

-- Migration complete: 'domain' entity type + two domain rows, user_integrations
-- scope pointer, bindings table, and the notion.inbox_db bootstrap for both scopes.

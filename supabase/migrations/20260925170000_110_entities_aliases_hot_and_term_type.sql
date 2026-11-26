-- Migration 110: aliases column, hot flag, and the 'term' entity type (#1023, ADR-092)
-- Issue: #1023 (two-tier memory: a decoder ring, and a hot tier in front of the graph)
-- ADR: ADR-092
-- Date: 2026-09-25
--
-- Three additive schema changes, all on public.entities, plus the people view
-- re-projected to expose the two new columns. The data step (copying the legacy
-- properties->'aliases' jsonb arrays into the new column) is migration 111, kept
-- separate per AGENTS.md "Separate a slow data step from a fast schema step".
--
-- 1. aliases text[] NOT NULL DEFAULT '{}'
--    Other names a person or entity answers to (nicknames, codenames, initials).
--    First-class, so matchers can read it without flattening a jsonb array
--    (ADR-047 recorded that properties.aliases could not enter the generated
--    search_vector for exactly that reason). GIN-indexed for array containment
--    / overlap lookups (aliases @> ARRAY['todd']).
--    A constant DEFAULT makes ADD COLUMN a catalogue-only change on PG 11+: no
--    table rewrite.
--
-- 2. hot boolean NOT NULL DEFAULT false
--    Hand-curated membership of the hot tier: the rows rendered into every MCP
--    session's handshake instructions (packages/mcp-server/src/hotTier.ts, capped
--    at 100 lines). A partial index serves the one query that reads it (the
--    owner's live hot rows); it stays tiny because the tier does.
--
-- 3. 'term' added to entities_entity_type_check
--    Acronyms and internal shorthand (PSR, P0, "the migration"). Expansion and
--    context live in properties (open-vocab, ADR-021). Distinct from migration
--    081's ontology term rows, which stay entity_type = 'concept' with
--    properties.type = 'ahos_concept_term'.
--    The rebuilt CHECK is the UNION of every prior value + 'term' (13 values) —
--    see migration 079's header for why omitting one would revoke it and fail
--    re-validation against live rows. Kept in sync BY HAND with ENTITY_TYPES in
--    packages/mcp-server/src/vocab.ts and GraphEntityType in @ahkms/shared.
--
-- 4. public.people re-projected with aliases and hot appended.
--    CREATE OR REPLACE VIEW may only APPEND columns; the existing 18 are
--    reproduced verbatim from migration 077 in the same order.
--
-- Backward compatibility: the deployed mcp-server reads these columns with a
-- retry-without fallback, and writes them only when a caller supplies them, so
-- code shipped before this file is pushed keeps working; nothing already
-- deployed selects them. Every statement is guarded (IF NOT EXISTS / IF EXISTS /
-- OR REPLACE), so a repeated application is a no-op.

SET statement_timeout = '5min';

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS hot boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_entities_aliases
  ON public.entities USING gin (aliases);

CREATE INDEX IF NOT EXISTS idx_entities_hot
  ON public.entities (user_id)
  WHERE hot AND NOT archived;

COMMENT ON COLUMN public.entities.aliases IS
  'Other names this row answers to (nicknames, codenames, initials). Read by people_match, people_query and entities_query; one shape, replacing the legacy properties->''aliases'' jsonb array (copied in by migration 111). #1023, ADR-092.';

COMMENT ON COLUMN public.entities.hot IS
  'Hand-curated hot-tier membership: true rows are rendered into every MCP session''s handshake instructions as the decoder ring (packages/mcp-server/src/hotTier.ts, HARD CAP 100 LINES). #1023, ADR-092.';

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
    'domain'::text,
    'arrangement'::text,
    'term'::text
  ]));

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
    hot
   FROM public.entities
  WHERE (entity_type = 'people'::text);

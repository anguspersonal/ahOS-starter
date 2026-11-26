-- Migration: add entities.source_url (issue #426, decided in the #339 grill D5, 2026-07-20)
-- Date: 2026-07-25
-- Purpose:
--   Every entity should carry a pointer to where it lives. Provenance today lives
--   only on the artifact side (artifact_external_links, keyed by artifact_id) and so
--   cannot describe an entity. The entities table has no source-URL slot at all — the
--   only place a URL can go is the free-form `properties` jsonb, which a constraint
--   cannot check.
--
--   `source_url` records the record that IS the entity — e.g. Sam's People row in
--   Notion. NOT the many pages that merely MENTION the entity (a task, a meeting note);
--   mentions are the discovered pointers themselves, reachable by search.
--
-- NULL has a documented meaning: THE ENTITY IS NATIVE TO THE GRAPH.
--   It came from a capture / was created by hand, not lifted from an external record
--   (e.g. Robbie, Lynsay Borthwick, Hannah Turner). NULL must NOT be read as "external
--   lookup failed" or "not yet fetched" — it is a positive statement that no external
--   home exists.
--
-- Real column, not a jsonb key: "all entities have a source url" is an invariant that
--   should be checkable by a constraint, not a convention. (Migration 070 already noted
--   one dead view leaned on `properties ->> 'url'`; this replaces that pattern for the
--   entity's own home.)
--
-- Additive nullable column, no backfill: every existing row is simply source_url IS NULL
--   (= native to the graph), which the partial unique index below ignores. Population is
--   a separate, deliberate pass (issue #426 acceptance) — this migration only adds the
--   slot. Blocked-on-#423 concerned population, not this schema change; #423 has landed
--   (PR #430) but we still do not populate here.

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS source_url text;

COMMENT ON COLUMN public.entities.source_url IS
  'URL of the external record that IS this entity (e.g. a person''s Notion People row), not pages that merely mention it. NULL = native to the graph (created from a capture or by hand, no external home) — NOT "lookup failed" or "not yet fetched". Uniqueness enforced per user via the partial unique index entities_user_source_url_unique.';

-- Partial unique index (only enforced when source_url IS NOT NULL): within one user's
-- graph, two entities must not both claim to be the same external record — a wrong merge
-- is far harder to unpick than a missing link. Scoped to (user_id, source_url), not a
-- bare global (source_url), because `entities` is multi-tenant (user_id + RLS): the node
-- that "is" Sam's People row is per-graph, and a global unique would let one user
-- capturing a public URL permanently block every other user from mapping the same
-- record. The stated invariant ("two entities must not both claim the same external
-- record") holds within each user's graph, which is the graph that matters. Follows the
-- partial-unique precedent in migration 064 (artifact_external_links.dedup_key).
-- Safe to add immediately: no existing row has a non-NULL source_url to violate it.
CREATE UNIQUE INDEX IF NOT EXISTS entities_user_source_url_unique
  ON public.entities (user_id, source_url)
  WHERE source_url IS NOT NULL;

-- Recreate public.people (last defined in migration 027) to surface source_url. The
-- people view is the read path for the people_* MCP tools; without this, people_query /
-- people_get could not expose the new column. CREATE OR REPLACE may only APPEND columns,
-- so source_url goes last and every existing column keeps its name/type/position.
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
    source_url
   FROM public.entities
  WHERE (entity_type = 'people'::text);

-- Migration complete: entities.source_url ready; population deferred to a later pass.

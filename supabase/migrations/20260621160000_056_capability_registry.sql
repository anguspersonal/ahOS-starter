-- Migration: Capability registry (ADR-031)
-- Date: 2026-06-21
-- Purpose:
--   Make capabilities (skills / agents / commands) first-class registry nodes, per
--   ADR-019 item #2, WITHOUT a new table. A capability is an `entities` row with
--   entity_type='capability'; typed fields live in `properties` and are validated by
--   the register_capability MCP tool. This migration adds only:
--     1. a partial unique index so capability names are unique per user, and
--     2. a `capabilities` view projecting the properties keys into columns, matching
--        the existing people / resources / projects view pattern (migration 011).
--
--   No store is replaced and no constraint is placed on entity_type itself (it stays
--   free-text, consistent with the other node types). See ADR-031 for the full model
--   and the "index + optional backup snapshot" amendment to ADR-019.
--
--   properties shape for entity_type='capability':
--     {
--       "kind": "skill" | "agent" | "command",
--       "surface": ["claude-code", "cowork", "chat", "api"],   -- non-empty array
--       "storage_location": "kms-db" | "kms-repo" | "claude" | "openai",
--       "storage_url": "<pointer to canonical home, null for kms-db>",
--       "body": "<plain-text bytes; authoritative iff kms-db, else backup snapshot>",
--       "body_synced_at": "<ISO 8601 timestamp the body copy was last refreshed>"
--     }

-- 1. Unique capability name per user (case-insensitive). Partial so it only governs
--    capability rows and never collides with other entity types.
CREATE UNIQUE INDEX IF NOT EXISTS capabilities_name_uniq
  ON public.entities (user_id, lower(title))
  WHERE entity_type = 'capability';

-- Helps the get_capabilities reads filter the registry cheaply.
CREATE INDEX IF NOT EXISTS idx_entities_capability
  ON public.entities (user_id)
  WHERE entity_type = 'capability';

-- 2. capabilities view — read model over the entities substrate. Mirrors the
--    people/resources views: typed properties surfaced as columns; full properties,
--    ownership, archival, and timestamps preserved. RLS on the underlying entities
--    table governs access (the MCP server uses the service role and filters by
--    user_id explicitly), matching the established view pattern.
CREATE OR REPLACE VIEW public.capabilities AS
  SELECT
    id,
    title AS name,
    description,
    (properties ->> 'kind') AS kind,
    (properties -> 'surface') AS surface,                              -- jsonb array
    (properties ->> 'storage_location') AS storage_location,
    (properties ->> 'storage_url') AS storage_url,
    ((properties ->> 'storage_location') LIKE 'kms-%') AS hosted,      -- derived
    (properties ->> 'body') AS body,
    ((properties ->> 'body_synced_at')::timestamptz) AS body_synced_at,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at
  FROM public.entities
  WHERE (entity_type = 'capability');

COMMENT ON VIEW public.capabilities IS
  'Capability registry (ADR-031): entities where entity_type=''capability''. hosted := storage_location LIKE ''kms-%''. body is authoritative iff storage_location=''kms-db'', else a backup snapshot (see body_synced_at).';

-- Migration complete: capability registry ready (entities-backed, view + unique index).

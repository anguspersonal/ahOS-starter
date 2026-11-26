-- Migration: 114_capability_registry_refinements.sql
-- Date: 2026-09-25
-- Purpose:
--   ADR-031 amendment: capability registry schema refinements (#344).
--   1. kind becomes a set (jsonb array of strings) so skill+agent twins are one honest row.
--      Migrates 'also:skill' tag into properties.kind and strips 'also:skill' and 'drift:twin-unsourced'.
--   2. surface becomes runtime ('claude-code' | 'claude-synced' | 'api'; 'cowork' renamed to 'claude-synced').
--      Moves client identifiers ('chat', 'cowork') to informational properties.clients array.
--   3. scope promoted to a real field in properties from 'scope:{global|personal|work|ahLtd}' tags,
--      stripping the tags.
--   4. Replaces public.capabilities view to project the refined columns: kind, surface, clients, scope.

SET statement_timeout = '60s';

-- 1. Migrate scope from tags into properties.scope and strip scope:* tags
UPDATE public.entities
SET
  properties = properties || jsonb_build_object(
    'scope',
    CASE
      WHEN 'scope:global' = ANY(tags) THEN 'global'
      WHEN 'scope:personal' = ANY(tags) THEN 'personal'
      WHEN 'scope:work' = ANY(tags) THEN 'work'
      WHEN 'scope:ahLtd' = ANY(tags) THEN 'ahLtd'
      ELSE properties->>'scope'
    END
  ),
  tags = array_remove(
    array_remove(
      array_remove(
        array_remove(tags, 'scope:global'),
        'scope:personal'
      ),
      'scope:work'
    ),
    'scope:ahLtd'
  )
WHERE entity_type = 'capability'
  AND tags && ARRAY['scope:global', 'scope:personal', 'scope:work', 'scope:ahLtd'];

-- 2. Migrate kind to jsonb array and fold 'also:skill' tag into kind
UPDATE public.entities
SET
  properties = properties || jsonb_build_object(
    'kind',
    CASE
      WHEN jsonb_typeof(properties->'kind') = 'string' THEN
        CASE
          WHEN 'also:skill' = ANY(tags) AND (properties->>'kind') <> 'skill' THEN
            jsonb_build_array(properties->>'kind', 'skill')
          ELSE
            jsonb_build_array(properties->>'kind')
        END
      WHEN jsonb_typeof(properties->'kind') = 'array' THEN
        CASE
          WHEN 'also:skill' = ANY(tags) AND NOT (properties->'kind' @> '["skill"]'::jsonb) THEN
            (properties->'kind') || '["skill"]'::jsonb
          ELSE
            properties->'kind'
        END
      WHEN properties->'kind' IS NULL THEN
        -- Key truly absent: every write path requires kind (registerCapabilityInput.kind
        -- is a required Zod field), so this is the safe default for a row that somehow
        -- never got one.
        jsonb_build_array('skill')
      ELSE
        -- Present but neither string nor array nor null (an unexpected shape this
        -- migration didn't anticipate): leave the value untouched rather than fabricate
        -- data over it — a one-way migration should no-op on the unknown case, not guess.
        properties->'kind'
    END
  ),
  tags = array_remove(array_remove(tags, 'also:skill'), 'drift:twin-unsourced')
WHERE entity_type = 'capability';

-- 3. Migrate surface (runtime) and clients (informational)
UPDATE public.entities
SET properties = properties
  || jsonb_build_object(
    'surface',
    COALESCE(
      (
        SELECT jsonb_agg(DISTINCT elem)
        FROM (
          SELECT CASE WHEN x = 'cowork' THEN 'claude-synced' ELSE x END AS elem
          FROM jsonb_array_elements_text(COALESCE(properties->'surface', '[]'::jsonb)) AS x
          WHERE x <> 'chat'
        ) s
      ),
      '["claude-synced"]'::jsonb
    )
  )
  || CASE
       WHEN properties->'surface' @> '["chat"]'::jsonb OR properties->'surface' @> '["cowork"]'::jsonb THEN
         jsonb_build_object(
           'clients',
           (
             SELECT jsonb_agg(DISTINCT elem)
             FROM (
               SELECT x AS elem
               FROM jsonb_array_elements_text(COALESCE(properties->'surface', '[]'::jsonb)) AS x
               WHERE x IN ('chat', 'cowork')
               UNION
               SELECT y AS elem
               FROM jsonb_array_elements_text(COALESCE(properties->'clients', '[]'::jsonb)) AS y
             ) u
           )
         )
       ELSE '{}'::jsonb
     END
WHERE entity_type = 'capability'
  AND (
    properties->'surface' @> '["cowork"]'::jsonb
    OR properties->'surface' @> '["chat"]'::jsonb
  );

-- 4. Recreate capabilities view with refined column types
DROP VIEW IF EXISTS public.capabilities;

CREATE VIEW public.capabilities AS
  SELECT
    id,
    title AS name,
    description,
    (properties -> 'kind') AS kind,                                    -- jsonb array
    (properties -> 'surface') AS surface,                              -- jsonb array (runtime)
    (properties -> 'clients') AS clients,                              -- jsonb array (informational clients)
    (properties ->> 'scope') AS scope,                                 -- text (global | personal | work | ahLtd)
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
  'Capability registry (ADR-031 amended): entities where entity_type=''capability''. kind is an array (twins supported). surface is runtime (claude-code|claude-synced|api). clients is informational (chat|cowork|mobile|cursor|ide|terminal). scope is identity-context (global|personal|work|ahLtd). hosted := storage_location LIKE ''kms-%''. body is authoritative iff storage_location=''kms-db'', else a backup snapshot (see body_synced_at).';

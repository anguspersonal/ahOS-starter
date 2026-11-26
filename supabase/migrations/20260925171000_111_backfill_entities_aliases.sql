-- Migration 111: copy legacy properties->'aliases' into entities.aliases (#1023, ADR-092)
-- Issue: #1023
-- ADR: ADR-092
-- Depends on: migration 110 (the aliases column)
-- Date: 2026-09-25
--
-- The worker's merge path (packages/worker/src/workflows/resume.ts) has recorded
-- a merged-away row's names as a jsonb array in properties.aliases. Migration 110
-- gives aliases a first-class text[] column; this one copies every existing jsonb
-- array into it, so the column is complete from the moment it is read.
--
-- UNION, not overwrite: anything already in the column (written through
-- people_update / entities_update between 110 and this file) is kept. Only
-- string elements are copied; blanks are dropped; duplicates are removed
-- case-insensitively, keeping the column's own spelling first.
--
-- Non-destructive: properties.aliases is left in place. Readers union both
-- shapes (packages/mcp-server/src/aliases.ts), and removing the jsonb copy is a
-- separate step once the merge writer stops producing it (follow-up to #1023).
--
-- The predicate `properties ? 'aliases'` is indexable by the existing GIN index
-- idx_entities_properties (jsonb_ops supports ?), rather than an extracted-path
-- comparison that no index can serve (the lesson of migration 104). Re-runnable:
-- the IS DISTINCT FROM guard means a second run updates no rows.

SET statement_timeout = '5min';

UPDATE public.entities AS e
SET aliases = merged.aliases
FROM (
  SELECT src.id,
         ARRAY(
           SELECT picked.alias
           FROM (
             SELECT DISTINCT ON (lower(btrim(c.alias))) btrim(c.alias) AS alias, c.ord
             FROM (
               SELECT a.alias, a.ord
               FROM unnest(src.aliases) WITH ORDINALITY AS a(alias, ord)
               UNION ALL
               SELECT j.value #>> '{}', 1000000 + j.ord
               FROM jsonb_array_elements(src.properties -> 'aliases') WITH ORDINALITY AS j(value, ord)
               WHERE jsonb_typeof(j.value) = 'string'
             ) AS c
             WHERE btrim(c.alias) <> ''
             ORDER BY lower(btrim(c.alias)), c.ord
           ) AS picked
           ORDER BY picked.ord
         ) AS aliases
  FROM public.entities AS src
  WHERE src.properties ? 'aliases'
    AND jsonb_typeof(src.properties -> 'aliases') = 'array'
) AS merged
WHERE e.id = merged.id
  AND e.aliases IS DISTINCT FROM merged.aliases;

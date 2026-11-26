-- Migration: drop unused "ghost" entity types from entities.entity_type CHECK
-- Issue: #172 (drop unused ghost entity types)
-- Date: 2026-07-07
--
-- Decision (Angus-approved, 2026-07-07): drop 'memory', 'secure', 'archive'
-- from the allowed entity_type set. 'event' is explicitly KEPT, along with
-- every other current value. Verified via prod query that all three dropped
-- types have ZERO rows in entities.entity_type today, so this is a pure
-- constraint-tightening with no data migration required. 'archive' is also
-- redundant with the existing `archived` boolean column on entities (see
-- idx_entities_archived in 20251226192107_011_update_entities_table.sql),
-- which is the actual mechanism used for archiving -- the 'archive' entity
-- type was never wired up to anything.
--
-- Mirrors the drop/recreate CHECK pattern from
-- 20260707120000_065_add_concept_entity_type.sql (itself following
-- 20260705150000_063_add_place_entity_type.sql), just removing values
-- instead of adding one. No partial index cleanup is needed: there is no
-- idx_entities_memory / idx_entities_secure / idx_entities_archive -- the
-- only entity-type-scoped partial indexes that exist are for
-- place/event/people/project/concept, none of which are affected here.
--
-- Guard: ADD CONSTRAINT re-validates every existing row against the new
-- (smaller) value set, so this migration will FAIL LOUDLY if any row still
-- has entity_type IN ('memory', 'secure', 'archive'). That is correct,
-- intentional behavior -- it means the "zero rows" assumption above no
-- longer holds and the migration must not silently succeed. Prod currently
-- has zero rows of these three types, so no failure is expected. If this
-- migration ever does fail, STOP and reconcile the offending rows (e.g.
-- retype or backfill) before re-attempting -- do not loosen the CHECK back
-- to "fix" the failure.
--
-- New allowed set (9 values, down from 12):
--   project, area, resource, people, event, organization, signal, place,
--   concept

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
    'concept'::text
  ]));

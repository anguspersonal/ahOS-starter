-- Migration: extend the entities.entity_type CHECK (PARAMPS + event + organization + signal)
-- ADR: ADR-025 (Event Entity Type)
-- Date: 2026-06-27
--
-- entities.entity_type was PARAMPS-only (project/area/resource/memory/people/
-- secure/archive), so dated happenings (a wedding, a meeting) had no home and
-- the process_artifact skill fell back to 'resource'. ADR-025 adds 'event' for
-- those.
--
-- Two further types are folded in here to match types the graph already uses in
-- the live store (entity_type was unguarded for a window, so rows accreted):
--   * organization — companies/institutions (e.g. a venue, the owner's company).
--                    The employed_by / member_of / vendor_for / client_of edges
--                    in vocab.ts presuppose org nodes, so this is a real gap, not
--                    stray data. Spelling matches stored rows ('organization').
--   * signal       — a derived, uncertain inference projected from an artifact
--                    (e.g. a tentative scheduling read), confidence in properties.
-- Type-specific data lives in the existing properties jsonb — no new columns.
-- Attendance is an edge (person -[attended]-> event); place is an edge
-- (event -[located_at]-> place) or properties.location.

ALTER TABLE public.entities
  DROP CONSTRAINT IF EXISTS entities_entity_type_check;

-- Pre-apply check: ADD CONSTRAINT re-validates every existing entities row, so a
-- stray entity_type outside the set below (a misspelling, a NULL, 'organisation'
-- vs 'organization') aborts this migration. The live store was inspected when
-- this was written (only event/organization/signal had accreted), but on a fresh
-- target run first:  SELECT DISTINCT entity_type FROM public.entities;
-- and confirm it is a subset of the values below before applying.
ALTER TABLE public.entities
  ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'project'::text,
    'area'::text,
    'resource'::text,
    'memory'::text,
    'people'::text,
    'secure'::text,
    'archive'::text,
    'event'::text,
    'organization'::text,
    'signal'::text
  ]));

-- Mirror the people/project/resource pattern: a partial GIN index on properties
-- for event rows, so date/location property lookups stay fast.
CREATE INDEX IF NOT EXISTS idx_entities_event_properties
  ON public.entities USING gin (properties) WHERE (entity_type = 'event'::text);

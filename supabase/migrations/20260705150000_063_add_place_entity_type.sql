-- Migration: extend the entities.entity_type CHECK with 'place'
-- Issue: #188 (places as first-class entities)
-- Date: 2026-07-05
--
-- Interview capture surfaced that locations are invisible to the graph:
-- "Edinburgh" (a city) and "3 Avenue Villas" (an address) were mentioned in an
-- artifact and could not be extracted as entities, because entities.entity_type
-- only allowed PARAMPS + event + organization + signal (migration 054). Current
-- guidance ("places go in descriptions/tags") loses them as graph nodes.
--
-- One type, not one per granularity: subtype lives in properties.place_type
-- (city | address | venue | region | country), open-vocab per the ADR-021 ethos
-- of soft/extensible validation over rigid enums. Containment (address -> city
-- -> country) and person -> place edges are modelled as entity_relationships
-- rows (locatedIn / livesAt / basedNear), not new columns.
--
-- No new columns, no data statements -- CHECK-extension only, exact pattern of
-- 20260627130000_054_add_event_entity_type.sql.

ALTER TABLE public.entities
  DROP CONSTRAINT IF EXISTS entities_entity_type_check;

-- Pre-apply check: ADD CONSTRAINT re-validates every existing entities row, so a
-- stray entity_type outside the set below aborts this migration. On a fresh
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
    'signal'::text,
    'place'::text
  ]));

-- Mirror the event/people/project/resource pattern: a partial GIN index on
-- properties for place rows, so place_type / containment property lookups stay
-- fast.
CREATE INDEX IF NOT EXISTS idx_entities_place_properties
  ON public.entities USING gin (properties) WHERE (entity_type = 'place'::text);

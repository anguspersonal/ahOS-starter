-- Migration: add 'capability' to the entities.entity_type CHECK
-- Issue: #63 (rationalise cowork-skills vs claude-code skills — registry seed)
-- Date: 2026-07-13
--
-- Fixes a latent regression in the ADR-031 capability registry. Migration
-- 20260621160000_056_capability_registry.sql built the `capabilities` view and
-- the capabilities_name_uniq index for entities where entity_type='capability',
-- and its header asserts "no constraint is placed on entity_type itself (it
-- stays free-text)". That assertion was never true of the live schema: an
-- entities_entity_type_check CHECK constraint already existed (drop/recreate
-- pattern established by 20260705150000_063_add_place_entity_type.sql and
-- 20260707120000_065_add_concept_entity_type.sql), and 056 never added
-- 'capability' to it. The registry was therefore impossible to seed — every
-- INSERT of a capability row fails the CHECK. 20260707140000_067 later tightened
-- the set to 9 values, still without 'capability'. This migration adds it.
--
-- Mirrors the drop/recreate CHECK pattern from 065/067, adding one value.
-- No partial index cleanup or data migration is needed: this only widens the
-- allowed set, so ADD CONSTRAINT re-validates every existing row against a
-- SUPERSET of the current constraint and cannot fail on existing data.
--
-- New allowed set (10 values, up from 9): the nine from 067 plus 'capability'.
--   project, area, resource, people, event, organization, signal, place,
--   concept, capability

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
    'capability'::text
  ]));

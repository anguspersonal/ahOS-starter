-- Migration 146: add 'decision' entity type (#2003, ADR-038 §6)
-- Issue: #2003 (feat(entities): add decision to entities_entity_type_check and surface allowed entity_type enum in action schema)
-- ADR: ADR-038 §6
-- Date: 2026-10-26
--
-- Adds 'decision' as the 14th allowed entity_type in public.entities.
-- Kept in sync BY HAND with ENTITY_TYPES in packages/mcp-server/src/vocab.ts,
-- ENTITY_TYPES in packages/core/src/actions/domain/entities.ts, and
-- GraphEntityType in @ahkms/shared.
--
-- UNION rationale (14 values): the constraint we DROP includes the 13 values
-- migration 110 rebuilt it to; the rebuilt CHECK must be the UNION of all prior
-- values + 'decision' so existing rows continue to validate.

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
    'term'::text,
    'decision'::text
  ]));

-- Migration: extend the entities.entity_type CHECK with 'concept'
-- Issue: #209 (promote concept to a first-class entity type), supersedes PR #200
-- Date: 2026-07-07
--
-- Context (see docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md "2026-07-05
-- concept incident" for the full story): during the #188 (place) release, a
-- different Claude session used the Supabase MCP apply_migration tool
-- (banned by the runbook -- prod DDL goes through the repo flow ONLY) to add
-- 'concept' to this same CHECK ad-hoc, then seeded 7 concept entities
-- (tag-promotions: Design, Graphics, Motion, Video, Content, Mobile, Events).
-- That write was unrecorded/orphaned relative to the repo and was remediated:
-- the 7 rows were retyped to 'resource' with
-- properties.original_entity_type = 'concept' preserved (zero data loss,
-- revivable in one UPDATE), and the live constraint was re-asserted to
-- EXACTLY what migration 063 defines (no 'concept'). See issue #209.
--
-- This migration is the properly-reviewed, repo-flow replacement for that
-- ad-hoc change: it re-adds 'concept' to the CHECK the sanctioned way (PR ->
-- merge -> `supabase db push`), per the product decision recorded in #209
-- (option 1: full pipeline) and docs/ADRs/ADR-DRAFT-concept-entity-type.md.
--
-- Anchoring: 'concept' is anchored to the W3C SKOS class skos:Concept
-- (adopt-direct per ADR033 -- skos:Concept is an exact match for "a topic/
-- subject node", no ahos: proxy or skos:closeMatch hedge needed). Concepts
-- reuse the SKOS broader/narrower hierarchy edges already adopted in #232
-- and the existing `about` edge for artifact/entity -> concept links -- no
-- new edge type is introduced by this migration.
--
-- Pure DDL, no data seeding: the 7 pre-existing rows currently typed
-- 'resource' with properties.original_entity_type = 'concept' are REVIVED
-- POST-MERGE by the orchestrator via MCP execute_sql (DML, not DDL -- per
-- the runbook's "MCP execute_sql is for data and reads" rule), NOT by this
-- migration. The revive statement:
--   UPDATE entities SET entity_type = 'concept'
--   WHERE entity_type = 'resource'
--     AND properties->>'original_entity_type' = 'concept';
--
-- One type, exact idempotent pattern of
-- 20260705150000_063_add_place_entity_type.sql: drop-and-recreate the CHECK
-- with the full value list including 'concept', plus a partial GIN index
-- mirroring the place/event/people/project pattern.

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
    'place'::text,
    'concept'::text
  ]));

-- Mirror the place/event/people/project pattern: a partial GIN index on
-- properties for concept rows, so concept-specific property lookups
-- (e.g. an origin_tag/provenance key) stay fast.
CREATE INDEX IF NOT EXISTS idx_entities_concept_properties
  ON public.entities USING gin (properties) WHERE (entity_type = 'concept'::text);

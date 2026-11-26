-- Migration: add 'arrangement' entity type (ADR-035 relationship reification)
-- Issue: #327 (implement ADR-035 — slice 1+2: type + participant vocab; unblocks #326)
-- ADR: ADR-035 §2 (the `arrangement` entity type — one generic reified-fact node type)
-- Date: 2026-07-26
--
-- ADR-035 reifies n-ary / repeated facts — employment with role+dates, residency with
-- several residents, supply chains — into their own `arrangement` node, with per-role
-- participant edges (employer/employee/resident/at_place/supplier/customer/of_utility,
-- added to EDGE_TYPES — open-vocab, no migration) and time on valid_from/valid_to
-- (migration 068). The arrangement KIND lives in `properties.kind`, open-vocab
-- (employment | residency | supply | ...), per ADR-021 soft validation — new kinds need
-- NO migration. This is the single CHECK migration ADR-035 §Consequences calls for; it
-- unblocks the ahOS-seed.ttl seed ingestion (#326), whose 6 arrangement nodes currently
-- have no legal entity_type.
--
-- Mirrors the drop/recreate CHECK pattern from migrations 067 (drop ghost types), 074
-- (add capability) and 075 (add domain). Kept in sync BY HAND with ENTITY_TYPES in
-- packages/mcp-server/src/vocab.ts and GraphEntityType in @ahkms/shared — update all
-- three together.
--
-- UNION rationale (why 12 values, not 1): the constraint we DROP already includes the 11
-- values migration 075 rebuilt it to (the 9 pre-067 + 'capability' from 074 + 'domain'
-- from 075), and prod carries rows of those types. The rebuilt CHECK MUST be the UNION of
-- all prior additions + 'arrangement' — an ADD CONSTRAINT that omitted any existing value
-- would revoke it AND fail re-validation against those live rows.
--
-- New allowed set (12 values): the 11 from migration 075 + 'arrangement'.
--   project, area, resource, people, event, organization, signal, place,
--   concept, capability, domain, arrangement
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
    'arrangement'::text
  ]));

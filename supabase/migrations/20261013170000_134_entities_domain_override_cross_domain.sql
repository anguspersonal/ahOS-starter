-- Migration: entities_domain_override check constraint expansion to cross-domain
-- ADR: ADR-107 (Three-value entity domain axis: work, angus, cross-domain; level: meta per ADR-036)
-- Issue: #1762
-- Date: 2026-10-13

ALTER TABLE public.entities
  DROP CONSTRAINT IF EXISTS entities_domain_override_check;

ALTER TABLE public.entities
  ADD CONSTRAINT entities_domain_override_check
  CHECK (domain_override IS NULL OR domain_override = ANY (ARRAY[
    'work'::text, 'angus'::text, 'cross-domain'::text
  ]));

COMMENT ON COLUMN public.entities.domain_override IS
  'Optional, narrow exception hook (ADR-084, ADR-107): NULL for the ordinary case, where domain is derived at read via PARA containment then the domain_signals classifier. Set only for the residue neither rule reaches, or to correct a wrong derivation — once set, this value is read verbatim and is never re-derived. Values match packages/core/src/domain/domains.ts ENTITY_DOMAINS (work, angus, cross-domain); keep the CHECK in sync by hand if that set changes. System abstraction tier is tracked orthogonally via properties.level (meta/ontology) per ADR-036. Not the entity_type=''domain'' binding-scope node (migration 075) — an unrelated axis.';

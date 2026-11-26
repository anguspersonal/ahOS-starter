-- Migration: drop dead migration-011 views (public.memories / public.secure / public.archive)
-- Issue: #263 (retire dead migration-011 views)
-- Date: 2026-07-07
--
-- Context: migration 011 (20251226192107) created seven convenience views over
-- `entities`, one per PARAMPS entity_type: archive, areas, memories, people,
-- projects, resources, secure. Migration 067 (20260707140000, #172) dropped
-- 'memory', 'secure', and 'archive' from the entities.entity_type CHECK
-- constraint -- those three entity types no longer exist, so the three views
-- that filter on them (public.memories, public.secure, public.archive) can
-- never return a row and are dead. The other four views (areas, people,
-- projects, resources) filter on entity_type values that are still live and
-- are NOT touched by this migration.
--
-- Verified before dropping (see PR description for full grep evidence):
--   - No application code queries these views (`.from('memories')`,
--     `.from('secure')`, `.from('archive')` do not appear anywhere in
--     packages/*/src). All entity reads go through `entities` directly.
--   - No later migration or RPC function selects FROM these views.
--   - No generated Supabase types file exists in the repo to update.
--   - packages/mcp-server/src/vocab.ts and packages/shared/src/types/entities.ts
--     already carry a comment (added alongside #172) documenting that these
--     views are the dead byproduct of the ghost entity-type removal.
--
-- These are ordinary views (not materialized), so DROP VIEW is the correct form.

DROP VIEW IF EXISTS public.memories;
DROP VIEW IF EXISTS public.secure;
DROP VIEW IF EXISTS public.archive;

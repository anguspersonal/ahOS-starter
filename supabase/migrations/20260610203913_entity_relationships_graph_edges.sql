-- Migration: make entity_relationships usable as knowledge-graph edges
-- Date: 2026-06-10
--
-- NOTE: vendored back into the repo on 2026-06-15 to reconcile migration drift (#87).
-- This DDL was applied to the remote DB (supabase_migrations version 20260610203913)
-- but had no corresponding file in the repo. The body below is the exact applied SQL.
--
-- Add the missing metadata column and drop the rigid relationship_type CHECK so
-- entity<->entity edges (works_with, knows, about, met_at, ...) become writable.
-- Edge vocabulary is now governed in the app layer (packages/mcp-server/src/vocab.ts).

ALTER TABLE "public"."entity_relationships"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "public"."entity_relationships"
  DROP CONSTRAINT IF EXISTS "entity_relationships_relationship_type_check";

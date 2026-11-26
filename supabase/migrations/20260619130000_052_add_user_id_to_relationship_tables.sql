-- Migration: add direct user_id ownership to artifact_entity_links and entity_relationships
-- Issue: #112
-- Date: 2026-06-19
--
-- Both tables previously inferred ownership via joins to artifacts/entities.
-- This migration adds an explicit user_id column so RLS and queries are direct,
-- making graph rendering and dedupe flows simpler and more reliable.

-- ============================================================
-- artifact_entity_links
-- ============================================================

ALTER TABLE public.artifact_entity_links
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- Backfill: stamp all existing rows with the single owner's user id.
UPDATE public.artifact_entity_links
SET user_id = '3027f544-61ba-4926-bdfa-9604036228e4'
WHERE user_id IS NULL;

-- Enforce NOT NULL (all rows should have been backfilled above).
ALTER TABLE public.artifact_entity_links
  ALTER COLUMN user_id SET NOT NULL;

-- Index for direct user_id lookups.
CREATE INDEX IF NOT EXISTS artifact_entity_links_user_id_idx
  ON public.artifact_entity_links (user_id);

-- Update unique constraint to be user-scoped so upsert conflict detection is correct.
ALTER TABLE public.artifact_entity_links
  DROP CONSTRAINT IF EXISTS artifact_entity_links_artifact_id_entity_id_link_type_key;

ALTER TABLE public.artifact_entity_links
  ADD CONSTRAINT artifact_entity_links_user_artifact_entity_link_type_key
  UNIQUE (user_id, artifact_id, entity_id, link_type);

-- Replace join-based RLS with direct user_id checks.
DROP POLICY IF EXISTS "Users can delete own artifact_entity_links" ON public.artifact_entity_links;
DROP POLICY IF EXISTS "Users can insert own artifact_entity_links" ON public.artifact_entity_links;
DROP POLICY IF EXISTS "Users can update own artifact_entity_links" ON public.artifact_entity_links;
DROP POLICY IF EXISTS "Users can view own artifact_entity_links"   ON public.artifact_entity_links;

CREATE POLICY "Users can select own artifact_entity_links"
  ON public.artifact_entity_links FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own artifact_entity_links"
  ON public.artifact_entity_links FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own artifact_entity_links"
  ON public.artifact_entity_links FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own artifact_entity_links"
  ON public.artifact_entity_links FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================
-- entity_relationships
-- ============================================================

ALTER TABLE public.entity_relationships
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- Backfill: stamp all existing rows with the single owner's user id.
UPDATE public.entity_relationships
SET user_id = '3027f544-61ba-4926-bdfa-9604036228e4'
WHERE user_id IS NULL;

-- Enforce NOT NULL.
ALTER TABLE public.entity_relationships
  ALTER COLUMN user_id SET NOT NULL;

-- Index for direct user_id lookups.
CREATE INDEX IF NOT EXISTS entity_relationships_user_id_idx
  ON public.entity_relationships (user_id);

-- Unique constraint scoped by user for safe native upsert.
ALTER TABLE public.entity_relationships
  DROP CONSTRAINT IF EXISTS entity_relationships_user_from_to_type_key;

ALTER TABLE public.entity_relationships
  ADD CONSTRAINT entity_relationships_user_from_to_type_key
  UNIQUE (user_id, from_entity_id, to_entity_id, relationship_type);

-- RLS: direct user_id scoping (entity_relationships had no policies before).
DROP POLICY IF EXISTS "Users can select own entity_relationships" ON public.entity_relationships;
DROP POLICY IF EXISTS "Users can insert own entity_relationships" ON public.entity_relationships;
DROP POLICY IF EXISTS "Users can update own entity_relationships" ON public.entity_relationships;
DROP POLICY IF EXISTS "Users can delete own entity_relationships" ON public.entity_relationships;

CREATE POLICY "Users can select own entity_relationships"
  ON public.entity_relationships FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own entity_relationships"
  ON public.entity_relationships FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own entity_relationships"
  ON public.entity_relationships FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own entity_relationships"
  ON public.entity_relationships FOR DELETE
  USING (auth.uid() = user_id);

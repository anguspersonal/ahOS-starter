-- Migration: FOAF relationship graph groundwork + entity_relationships reconciliation
-- Date: 2026-07-04
-- Purpose:
--   ADR-021: adopt FOAF + the RELATIONSHIP vocabulary for a defined interpersonal
--   knowledge graph. Relationship types are validated in the application layer
--   (soft, with an 'other' escape hatch) — NOT with a hard DB CHECK.
--
--   Production's entity_relationships has drifted well ahead of the migration
--   history (columns/constraints were added out-of-band): live already has a
--   metadata jsonb column, a NOT NULL user_id (FK to auth.users), a
--   UNIQUE (user_id, from_entity_id, to_entity_id, relationship_type), user_id-based
--   RLS, and no relationship_type CHECK. A DB built purely from these migrations has
--   none of that. This migration reconciles the two so a fresh/CI database matches
--   production, and is fully idempotent — every statement is a no-op on prod.
--
--   All changes are additive/non-destructive; no rows are dropped.

BEGIN;

-- 1. Remove the stale hard CHECK (present on migration-built DBs, already absent on
--    prod). No replacement — the vocabulary is enforced in @ahkms/shared.
ALTER TABLE public.entity_relationships
  DROP CONSTRAINT IF EXISTS entity_relationships_relationship_type_check;

-- 2. metadata jsonb: the co-occurrence writer (organizeEntities.ts) already stores
--    { co_occurrence_count, first/last_occurred_at, artifact_id } here; ensure it exists.
ALTER TABLE public.entity_relationships
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.entity_relationships.metadata IS
  'Free-form edge metadata (co-occurrence counts, seed provenance, etc.). See ADR-021.';

-- 3. user_id: production carries a NOT NULL owner column the migration history never
--    added. Add it nullable, backfill from the owning (from) entity, then enforce.
ALTER TABLE public.entity_relationships
  ADD COLUMN IF NOT EXISTS user_id uuid;

UPDATE public.entity_relationships er
SET user_id = e.user_id
FROM public.entities e
WHERE e.id = er.from_entity_id AND er.user_id IS NULL;

ALTER TABLE public.entity_relationships
  ALTER COLUMN user_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.entity_relationships'::regclass
      AND conname = 'entity_relationships_user_id_fkey'
  ) THEN
    ALTER TABLE public.entity_relationships
      ADD CONSTRAINT entity_relationships_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 4. Edge idempotency guard (matches production) — one edge per (owner, from, to, type).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.entity_relationships'::regclass
      AND conname = 'entity_relationships_user_from_to_type_key'
  ) THEN
    ALTER TABLE public.entity_relationships
      ADD CONSTRAINT entity_relationships_user_from_to_type_key
      UNIQUE (user_id, from_entity_id, to_entity_id, relationship_type);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_entity_rel_user ON public.entity_relationships(user_id);

-- 5. user_id-based RLS (matches prod). Drop the legacy from-side EXISTS SELECT policy
--    and any older variants, then recreate the four owner-scoped policies.
DROP POLICY IF EXISTS "Users can view own entity_relationships" ON public.entity_relationships;
DROP POLICY IF EXISTS "Users can select own entity_relationships" ON public.entity_relationships;
DROP POLICY IF EXISTS "Users can insert own entity_relationships" ON public.entity_relationships;
DROP POLICY IF EXISTS "Users can update own entity_relationships" ON public.entity_relationships;
DROP POLICY IF EXISTS "Users can delete own entity_relationships" ON public.entity_relationships;

CREATE POLICY "Users can select own entity_relationships"
ON public.entity_relationships AS PERMISSIVE FOR SELECT TO public
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own entity_relationships"
ON public.entity_relationships AS PERMISSIVE FOR INSERT TO public
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own entity_relationships"
ON public.entity_relationships AS PERMISSIVE FOR UPDATE TO public
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own entity_relationships"
ON public.entity_relationships AS PERMISSIVE FOR DELETE TO public
USING (auth.uid() = user_id);

COMMIT;

-- Migration complete: entity_relationships reconciled + ready for the FOAF/RELATIONSHIP vocabulary.

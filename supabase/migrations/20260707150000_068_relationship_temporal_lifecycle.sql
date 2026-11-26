-- Migration: Temporal validity + soft-delete lifecycle on entity_relationships
-- Date: 2026-07-07
-- Issue: #175
-- Purpose:
--   Relationships currently have no notion of time bounds or lifecycle state —
--   an edge is either present or hard-deleted. This blocks representing things
--   like "worked at X from 2019 to 2022" or archiving a stale edge without
--   losing its history. This migration brings entity_relationships to parity
--   with entities' existing archived/archived_at + updated_at pattern (see
--   20251226192107_011_update_entities_table.sql), and adds the two nullable
--   time-bound columns relationships need that entities don't.
--
--   Dedup: migration 062 (20260704120000_062_foaf_relationship_graph.sql)
--   already added UNIQUE (user_id, from_entity_id, to_entity_id, relationship_type)
--   as entity_relationships_user_from_to_type_key. This migration does NOT
--   re-add it — see the guarded check below, which is a no-op assertion that
--   documents the dependency rather than re-creating the constraint.
--
--   Additive only: every new column is nullable or has a safe default, so
--   packages/worker's existing `.insert({...})` calls (organizeEntities.ts,
--   createDerived.ts, resume.ts) continue to work unchanged. Idempotent via
--   IF NOT EXISTS / IF EXISTS guards throughout.

BEGIN;

-- 1. Time-bounded validity. Both nullable: a NULL valid_from/valid_to means
--    "no known bound in that direction" (open-ended), not "invalid".
ALTER TABLE public.entity_relationships
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_to timestamptz;

COMMENT ON COLUMN public.entity_relationships.valid_from IS
  'Start of the relationship''s validity window. NULL = unknown/unbounded start. See issue #175.';
COMMENT ON COLUMN public.entity_relationships.valid_to IS
  'End of the relationship''s validity window. NULL = still active/unbounded end. See issue #175.';

-- 2. Lifecycle: soft-delete via `archived`, mirroring entities' archived
--    column (20251226192107_011_update_entities_table.sql). No archived_at
--    here — updated_at already captures "when did this row last change",
--    and relate_entities/entityRelationships.ts read archived transitions
--    off updated_at rather than a dedicated timestamp.
ALTER TABLE public.entity_relationships
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.entity_relationships.archived IS
  'Soft-delete flag. Archived edges are excluded from default reads but retained for history. See issue #175.';

-- 3. updated_at, maintained by the same generic trigger function entities'
--    peer tables already share (public.update_updated_at_column(), defined
--    in 20251226182232_remote_schema.sql and used by system_decisions).
--    Reused rather than inventing update_entity_relationships_updated_at().
ALTER TABLE public.entity_relationships
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.entity_relationships.updated_at IS
  'Maintained by trigger_entity_relationships_updated_at. See issue #175.';

DROP TRIGGER IF EXISTS trigger_entity_relationships_updated_at ON public.entity_relationships;
CREATE TRIGGER trigger_entity_relationships_updated_at
  BEFORE UPDATE ON public.entity_relationships
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Partial index for the hot path: active (non-archived) edges keyed by
--    owner + endpoints, matching the shape entityNeighbourhood.ts and
--    relateEntities.ts query on today.
CREATE INDEX IF NOT EXISTS idx_entity_rel_active
  ON public.entity_relationships (user_id, from_entity_id, to_entity_id)
  WHERE archived = false;

-- 5. Dedup guard: assert 062's UNIQUE constraint is present rather than
--    re-adding it. Fails loudly (instead of silently drifting) if a future
--    change ever drops entity_relationships_user_from_to_type_key without
--    updating this migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.entity_relationships'::regclass
      AND conname = 'entity_relationships_user_from_to_type_key'
  ) THEN
    RAISE EXCEPTION
      'entity_relationships_user_from_to_type_key is missing — expected from migration 062 (20260704120000_062_foaf_relationship_graph.sql). Issue #175 depends on it for edge dedup and does not re-create it here.';
  END IF;
END $$;

COMMIT;

-- Migration complete: entity_relationships now supports time-bounded validity
-- (valid_from/valid_to), soft-delete (archived), and updated_at tracking,
-- at parity with entities. Dedup already enforced by migration 062.

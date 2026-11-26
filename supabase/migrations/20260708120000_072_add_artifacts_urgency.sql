-- Migration: Add urgency column to artifacts
-- Date: 2026-07-08
-- Issue: #297 (slice 2 of the capture-consolidation decision, #94)
-- Purpose:
--   User-supplied, capture-time "urgency dial" (May-12 affordance ported per the
--   ratified decision doc docs/design/capture-skill-consolidation.md). Capture only
--   *writes* this value faithfully; it never acts on it. It is read at synthesis /
--   enrich time (the enrich consumer, #52) to decide how much to do — consistent with
--   ADR-018 (capture dumb, synthesis smart).
--
-- Safety / ordering: this migration ONLY adds the (nullable) column. It must be applied
-- to prod via `supabase db push` BEFORE the capture tool starts writing the field
-- (slice 2b), so no capture insert references a column that does not yet exist.

-- Step 1: nullable TEXT column (existing rows and non-urgency captures stay valid).
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS urgency TEXT;

-- Step 2: constrain to the ported vocabulary (idempotent — guard on pg_constraint).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_urgency_check'
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_urgency_check
      CHECK (urgency IS NULL OR urgency IN ('throw', 'default', 'file'));
  END IF;
END $$;

-- Step 3: partial index for the enrich consumer's urgency-aware selection (#52).
CREATE INDEX IF NOT EXISTS idx_artifacts_urgency
  ON artifacts(urgency)
  WHERE urgency IS NOT NULL;

-- Step 4: document intent at the schema level.
COMMENT ON COLUMN artifacts.urgency IS
  'User-supplied capture-time urgency dial (throw|default|file). Written faithfully by capture, never acted on; read at enrich/synthesis time (#52). ADR-018. Issue #297.';

-- Migration complete: artifacts.urgency added (nullable, checked, indexed).

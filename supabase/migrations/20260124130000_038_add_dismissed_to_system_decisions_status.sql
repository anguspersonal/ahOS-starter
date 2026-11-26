-- Migration: Add 'dismissed' status to system_decisions.status constraint
-- Date: 2026-01-24
-- Purpose: Add 'dismissed' status value to support notification dismiss functionality
-- Requirements: 5.3, 5.4 (from web-app-refactor-4.1-4.4)

BEGIN;

-- Step 1: Drop existing status constraint
ALTER TABLE public.system_decisions 
  DROP CONSTRAINT IF EXISTS system_decisions_status_check;

-- Step 2: Recreate constraint with 'dismissed' included
ALTER TABLE public.system_decisions 
  ADD CONSTRAINT system_decisions_status_check 
  CHECK (
    status = ANY (
      ARRAY[
        'pending'::text,
        'auto_applied'::text,
        'approved'::text,
        'rejected'::text,
        'modified'::text,
        'snoozed'::text,
        'expired'::text,
        'dismissed'::text
      ]
    )
  );

COMMIT;

-- Migration complete: 'dismissed' status added to system_decisions.status constraint

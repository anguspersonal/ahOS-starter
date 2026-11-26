-- Migration: Add 'complete' stage to system_decisions.stage constraint
-- Date: 2026-03-08
-- Purpose: Allow workflow_complete notifications to use stage = 'complete'
-- Root cause: createCompletionNotification() inserts stage 'complete'; constraint only allowed
--   capture, organize, pre_process, extract, contextualize, act, refine, automate.

BEGIN;

-- Step 1: Drop existing stage constraint
ALTER TABLE public.system_decisions
  DROP CONSTRAINT IF EXISTS system_decisions_stage_check;

-- Step 2: Recreate constraint with 'complete' included
ALTER TABLE public.system_decisions
  ADD CONSTRAINT system_decisions_stage_check
  CHECK (
    stage = ANY (
      ARRAY[
        'capture'::text,
        'organize'::text,
        'pre_process'::text,
        'extract'::text,
        'contextualize'::text,
        'act'::text,
        'refine'::text,
        'automate'::text,
        'complete'::text
      ]
    )
  );

COMMIT;

-- Migration complete: 'complete' stage added for workflow_complete notifications

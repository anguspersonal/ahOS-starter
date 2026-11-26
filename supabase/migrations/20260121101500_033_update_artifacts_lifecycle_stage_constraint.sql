-- Expand allowed values for artifacts.lifecycle_stage to match app/worker code.
-- This fixes cases where lifecycle updates silently fail due to a CHECK constraint mismatch
-- (e.g. high-confidence analyze tries to set 'analysed' but DB only allows legacy stages).

BEGIN;

ALTER TABLE public.artifacts
  DROP CONSTRAINT IF EXISTS artifacts_lifecycle_stage_check;

ALTER TABLE public.artifacts
  ADD CONSTRAINT artifacts_lifecycle_stage_check
  CHECK (
    lifecycle_stage = ANY (
      ARRAY[
        -- Current app values (packages/shared/src/types/knowledge.ts)
        'uploaded'::text,
        'upload_failed'::text,
        'processing'::text,
        'analysed'::text,
        'analysis_failed'::text,
        'needs_review'::text,
        'entities_extracted'::text,
        'actions_extracted'::text,
        'artifacts_created'::text,
        'complete'::text,
        'blocked'::text,
        'failed'::text,
        'archived'::text,

        -- Legacy values kept for backward compatibility with older data
        'extracted'::text,
        'contextualized'::text,
        'actionable'::text,
        'refined'::text,
        'processed'::text
      ]
    )
  );

COMMIT;


-- Add original_file_name to artifacts for semantic filenaming.
-- Preserves the exact upload filename; filename column is updated to a semantic name after analysis.

ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS original_file_name text;

COMMENT ON COLUMN public.artifacts.original_file_name IS 'Exact filename at upload; never overwritten. Used for extension and display when semantic filename is set.';

-- Backfill: existing rows keep current filename as both original and semantic until next analysis
UPDATE public.artifacts
SET original_file_name = filename
WHERE original_file_name IS NULL AND filename IS NOT NULL;

-- Migration: Add CHECK constraint to artifacts.artifact_type
-- Purpose: Ensure artifacts.artifact_type is either NULL (for backward compatibility) or 'original'
-- Derived artifacts use derived_artifacts table with different artifact_type values

-- Step 1: Clean up existing data - set all non-NULL artifact_type values to 'original'
-- This fixes any MIME type values that were incorrectly set by old code
UPDATE "public"."artifacts"
SET "artifact_type" = 'original'
WHERE "artifact_type" IS NOT NULL 
  AND "artifact_type" != 'original';

-- Step 2: Add CHECK constraint to artifacts.artifact_type
ALTER TABLE "public"."artifacts" 
  ADD CONSTRAINT "artifacts_artifact_type_check" 
  CHECK ("artifact_type" IS NULL OR "artifact_type" = 'original'::text);

-- Step 3: Add comment to document the constraint
COMMENT ON COLUMN "public"."artifacts"."artifact_type" IS 
  'Type of artifact: NULL (legacy) or ''original'' for uploaded artifacts. Derived artifacts use derived_artifacts table with types: split_page, ocr_text, thumbnail, extracted_text, other';


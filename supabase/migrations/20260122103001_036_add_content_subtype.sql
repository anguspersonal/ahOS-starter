-- Migration: Add content_subtype field to artifacts table
-- Date: 2026-01-22
-- Purpose: Add TEXT column to identify derived artifacts and other content subtypes
-- Requirements: 6.8

-- Step 1: Add content_subtype TEXT column to artifacts table (nullable)
ALTER TABLE artifacts
ADD COLUMN IF NOT EXISTS content_subtype TEXT;

-- Step 2: Create index on content_subtype for querying derived artifacts
CREATE INDEX IF NOT EXISTS idx_artifacts_content_subtype
ON artifacts(content_subtype)
WHERE content_subtype IS NOT NULL;

-- Migration complete: content_subtype field added with index for querying

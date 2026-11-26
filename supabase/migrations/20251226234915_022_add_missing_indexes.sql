-- Migration: Add missing indexes from Implementation Plan 1.6
-- Date: 2025-12-26
-- Purpose: Add simple created_at index for artifacts and FTS index for entities.title

-- Add simple created_at DESC index for artifacts
-- (Note: Composite index idx_artifacts_active_stage exists but this provides simpler ordering)
CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC);

-- Add full-text search index for entities.title
-- This enables efficient text search on entity titles
CREATE INDEX IF NOT EXISTS idx_entities_title_fts ON entities USING gin(to_tsvector('english', title));

-- Migration complete: Added missing indexes from Implementation Plan 1.6


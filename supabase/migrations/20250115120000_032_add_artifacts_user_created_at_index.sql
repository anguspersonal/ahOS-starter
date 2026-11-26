-- Migration: Add composite index for artifacts user_id + created_at queries
-- Date: 2025-01-15
-- Purpose: Optimize inbox queries that filter by user_id and order by created_at DESC
-- 
-- This index optimizes the common query pattern:
-- SELECT * FROM artifacts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
--
-- Without this index, PostgreSQL must:
-- 1. Use idx_artifacts_user_id_uuid to filter by user_id
-- 2. Sort all matching rows by created_at (potentially thousands)
-- 3. Apply LIMIT 50
--
-- With this composite index, PostgreSQL can:
-- 1. Use the index to filter by user_id AND order by created_at in one operation
-- 2. Only scan the first 50 rows needed
-- This reduces query time from 14-19 seconds to milliseconds

CREATE INDEX IF NOT EXISTS idx_artifacts_user_created_at 
  ON artifacts(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Migration complete: Added composite index for user_id + created_at queries


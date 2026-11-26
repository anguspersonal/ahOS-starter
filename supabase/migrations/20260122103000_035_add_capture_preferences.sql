-- Migration: Add capture_preferences field to user_preferences table
-- Date: 2026-01-22
-- Purpose: Add JSONB column to store user preferences for capture operations, including derived artifact creation
-- Requirements: 9.2, 9.3

-- Step 1: Add capture_preferences JSONB column to user_preferences table
ALTER TABLE user_preferences
ADD COLUMN IF NOT EXISTS capture_preferences JSONB DEFAULT '{"create_derived_artifacts": true}'::jsonb;

-- Step 2: Update existing rows to have default value if capture_preferences is null
UPDATE user_preferences
SET capture_preferences = '{"create_derived_artifacts": true}'::jsonb
WHERE capture_preferences IS NULL;

-- Migration complete: capture_preferences field added with default value

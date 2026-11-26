-- Migration: Update user_preferences table
-- Date: 2025-12-26
-- Purpose: Add missing fields from planned schema and ensure consistency

-- Step 1: Add missing columns (entity_match_threshold and entity_create_threshold)
-- These are for backward compatibility or specific use cases
ALTER TABLE user_preferences
ADD COLUMN IF NOT EXISTS entity_match_threshold DECIMAL(3,2) DEFAULT 0.8,
ADD COLUMN IF NOT EXISTS entity_create_threshold DECIMAL(3,2) DEFAULT 0.7;

-- Step 2: Update default for id column to use gen_random_uuid() for consistency
-- Note: This only affects future inserts, existing rows are unchanged
ALTER TABLE user_preferences
ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Step 3: Ensure ON DELETE CASCADE is set on user_id foreign key
-- Check if it already exists, if not, we'll need to drop and recreate
-- First, let's verify the constraint exists (it should based on remote schema)
-- If it doesn't have CASCADE, we'll need to recreate it
DO $$
BEGIN
  -- Check if the foreign key constraint exists and has ON DELETE CASCADE
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_preferences_user_id_fkey'
    AND contype = 'f'
    AND confdeltype = 'c'  -- 'c' means CASCADE
  ) THEN
    -- Drop existing constraint if it exists without CASCADE
    ALTER TABLE user_preferences
    DROP CONSTRAINT IF EXISTS user_preferences_user_id_fkey;
    
    -- Recreate with CASCADE
    ALTER TABLE user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Step 4: Create auto-update trigger for updated_at if it doesn't exist
CREATE OR REPLACE FUNCTION update_user_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if it exists and recreate
DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON user_preferences;
CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_user_preferences_updated_at();

-- Migration complete: user_preferences table updated with unified schema


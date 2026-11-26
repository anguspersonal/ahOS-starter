-- Migration: Update user_tasks table - convert foreign keys to UUID, add missing fields
-- Date: 2025-12-26

-- Step 1: Drop foreign key constraints that need to be recreated
ALTER TABLE user_tasks 
  DROP CONSTRAINT IF EXISTS user_tasks_source_artifact_id_fkey;

ALTER TABLE user_tasks 
  DROP CONSTRAINT IF EXISTS user_tasks_entity_id_fkey;

-- Step 2: Convert source_artifact_id from TEXT to UUID
-- Add new UUID column
ALTER TABLE user_tasks 
  ADD COLUMN source_artifact_id_new UUID;

-- Populate from artifacts table (artifacts.id is now UUID)
UPDATE user_tasks ut
SET source_artifact_id_new = a.id
FROM artifacts a
WHERE ut.source_artifact_id::uuid = a.id;

-- Drop old column and rename
ALTER TABLE user_tasks 
  DROP COLUMN source_artifact_id;

ALTER TABLE user_tasks 
  RENAME COLUMN source_artifact_id_new TO source_artifact_id;

-- Step 3: Convert entity_id from TEXT to UUID
-- Add new UUID column
ALTER TABLE user_tasks 
  ADD COLUMN entity_id_new UUID;

-- Populate from entities table (entities.id is now UUID)
UPDATE user_tasks ut
SET entity_id_new = e.id
FROM entities e
WHERE ut.entity_id::uuid = e.id;

-- Drop old column and rename
ALTER TABLE user_tasks 
  DROP COLUMN entity_id;

ALTER TABLE user_tasks 
  RENAME COLUMN entity_id_new TO entity_id;

-- Step 4: Add missing fields from planned schema
ALTER TABLE user_tasks 
  ADD COLUMN due_time TIME,
  ADD COLUMN duration_minutes INTEGER;

-- Step 5: Recreate foreign key constraints
ALTER TABLE user_tasks 
  ADD CONSTRAINT user_tasks_source_artifact_id_fkey 
  FOREIGN KEY (source_artifact_id) 
  REFERENCES artifacts(id) 
  ON DELETE SET NULL;

ALTER TABLE user_tasks 
  ADD CONSTRAINT user_tasks_entity_id_fkey 
  FOREIGN KEY (entity_id) 
  REFERENCES entities(id) 
  ON DELETE SET NULL;

-- Step 6: Create or replace updated_at trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION update_user_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 7: Create trigger for updated_at (drop if exists first)
DROP TRIGGER IF EXISTS update_user_tasks_updated_at ON user_tasks;

CREATE TRIGGER update_user_tasks_updated_at
  BEFORE UPDATE ON user_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_user_tasks_updated_at();

-- Migration complete: user_tasks table updated with UUID foreign keys and missing fields


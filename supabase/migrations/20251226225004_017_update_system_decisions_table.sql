-- Migration: Update system_decisions table - convert artifact_id to UUID, add missing fields
-- Date: 2025-12-26

-- Step 1: Drop foreign key constraint that needs to be recreated
ALTER TABLE system_decisions 
  DROP CONSTRAINT IF EXISTS system_decisions_artifact_id_fkey;

-- Step 2: Convert artifact_id from TEXT to UUID
-- Add new UUID column
ALTER TABLE system_decisions 
  ADD COLUMN artifact_id_new UUID;

-- Populate from artifacts table (artifacts.id is now UUID)
UPDATE system_decisions sd
SET artifact_id_new = a.id
FROM artifacts a
WHERE sd.artifact_id::uuid = a.id;

-- Drop old column and rename
ALTER TABLE system_decisions 
  DROP COLUMN artifact_id;

ALTER TABLE system_decisions 
  RENAME COLUMN artifact_id_new TO artifact_id;

-- Step 3: Add missing fields
ALTER TABLE system_decisions 
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resolution_data JSONB,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Step 4: Add NOT NULL constraints (only if data allows)
-- First, update any NULL values
UPDATE system_decisions 
SET description = '' 
WHERE description IS NULL;

UPDATE system_decisions 
SET review_type = 'suggestion' 
WHERE review_type IS NULL;

-- Now add NOT NULL constraints
ALTER TABLE system_decisions 
  ALTER COLUMN description SET NOT NULL,
  ALTER COLUMN review_type SET NOT NULL;

-- Step 5: Recreate foreign key constraint
ALTER TABLE system_decisions 
  ADD CONSTRAINT system_decisions_artifact_id_fkey 
  FOREIGN KEY (artifact_id) 
  REFERENCES artifacts(id) 
  ON DELETE CASCADE;

-- Step 6: Create or replace updated_at trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION update_system_decisions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 7: Create trigger for updated_at (drop and recreate to ensure it exists)
DROP TRIGGER IF EXISTS update_system_decisions_updated_at ON system_decisions;

CREATE TRIGGER update_system_decisions_updated_at
  BEFORE UPDATE ON system_decisions
  FOR EACH ROW
  EXECUTE FUNCTION update_system_decisions_updated_at();

-- Migration complete: system_decisions table updated with UUID artifact_id and missing fields


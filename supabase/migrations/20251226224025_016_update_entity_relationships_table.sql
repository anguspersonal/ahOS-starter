-- Migration: Update entity_relationships table - convert foreign keys to UUID
-- Date: 2025-12-26

-- Step 1: Drop RLS policies that reference columns we're changing
DROP POLICY IF EXISTS "Users can delete own entity_relationships" ON entity_relationships;
DROP POLICY IF EXISTS "Users can insert own entity_relationships" ON entity_relationships;
DROP POLICY IF EXISTS "Users can update own entity_relationships" ON entity_relationships;
DROP POLICY IF EXISTS "Users can view own entity_relationships" ON entity_relationships;

-- Step 2: Drop foreign key constraints that need to be recreated
ALTER TABLE entity_relationships 
  DROP CONSTRAINT IF EXISTS entity_relationships_from_entity_id_fkey;

ALTER TABLE entity_relationships 
  DROP CONSTRAINT IF EXISTS entity_relationships_to_entity_id_fkey;

-- Step 3: Drop check constraints that reference columns we're changing
ALTER TABLE entity_relationships 
  DROP CONSTRAINT IF EXISTS no_self_reference;

-- Step 4: Convert from_entity_id from TEXT to UUID
-- Add new UUID column
ALTER TABLE entity_relationships 
  ADD COLUMN from_entity_id_new UUID;

-- Populate from entities table (entities.id is now UUID)
UPDATE entity_relationships er
SET from_entity_id_new = e.id
FROM entities e
WHERE er.from_entity_id::uuid = e.id;

-- Drop old column and rename
ALTER TABLE entity_relationships 
  DROP COLUMN from_entity_id;

ALTER TABLE entity_relationships 
  RENAME COLUMN from_entity_id_new TO from_entity_id;

-- Set NOT NULL constraint
ALTER TABLE entity_relationships 
  ALTER COLUMN from_entity_id SET NOT NULL;

-- Step 5: Convert to_entity_id from TEXT to UUID
-- Add new UUID column
ALTER TABLE entity_relationships 
  ADD COLUMN to_entity_id_new UUID;

-- Populate from entities table (entities.id is now UUID)
UPDATE entity_relationships er
SET to_entity_id_new = e.id
FROM entities e
WHERE er.to_entity_id::uuid = e.id;

-- Drop old column and rename
ALTER TABLE entity_relationships 
  DROP COLUMN to_entity_id;

ALTER TABLE entity_relationships 
  RENAME COLUMN to_entity_id_new TO to_entity_id;

-- Set NOT NULL constraint
ALTER TABLE entity_relationships 
  ALTER COLUMN to_entity_id SET NOT NULL;

-- Step 6: Recreate check constraint (no self-reference)
ALTER TABLE entity_relationships 
  ADD CONSTRAINT no_self_reference 
  CHECK (from_entity_id <> to_entity_id);

-- Step 7: Recreate foreign key constraints
ALTER TABLE entity_relationships 
  ADD CONSTRAINT entity_relationships_from_entity_id_fkey 
  FOREIGN KEY (from_entity_id) 
  REFERENCES entities(id) 
  ON DELETE CASCADE;

ALTER TABLE entity_relationships 
  ADD CONSTRAINT entity_relationships_to_entity_id_fkey 
  FOREIGN KEY (to_entity_id) 
  REFERENCES entities(id) 
  ON DELETE CASCADE;

-- Step 8: Recreate RLS policies
CREATE POLICY "Users can view own entity_relationships"
ON entity_relationships FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_relationships.from_entity_id
    AND e.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert own entity_relationships"
ON entity_relationships FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_relationships.from_entity_id
    AND e.user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_relationships.to_entity_id
    AND e.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update own entity_relationships"
ON entity_relationships FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_relationships.from_entity_id
    AND e.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_relationships.from_entity_id
    AND e.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete own entity_relationships"
ON entity_relationships FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_relationships.from_entity_id
    AND e.user_id = auth.uid()
  )
);

-- Migration complete: entity_relationships table updated with UUID foreign keys


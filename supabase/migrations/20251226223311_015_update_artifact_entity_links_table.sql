-- Migration: Update artifact_entity_links table - convert foreign keys to UUID
-- Date: 2025-12-26

-- Step 1: Drop RLS policies that reference columns we're changing
DROP POLICY IF EXISTS "Users can delete own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can insert own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can update own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can view own artifact_entity_links" ON artifact_entity_links;

-- Step 2: Drop foreign key constraints that need to be recreated
ALTER TABLE artifact_entity_links 
  DROP CONSTRAINT IF EXISTS artifact_entity_links_artifact_id_fkey;

ALTER TABLE artifact_entity_links 
  DROP CONSTRAINT IF EXISTS artifact_entity_links_entity_id_fkey;

-- Step 3: Drop unique constraint (will recreate after column changes)
ALTER TABLE artifact_entity_links 
  DROP CONSTRAINT IF EXISTS artifact_entity_links_artifact_id_entity_id_link_type_key;

-- Step 4: Convert artifact_id from TEXT to UUID
-- Add new UUID column
ALTER TABLE artifact_entity_links 
  ADD COLUMN artifact_id_new UUID;

-- Populate from artifacts table (artifacts.id is now UUID)
UPDATE artifact_entity_links ael
SET artifact_id_new = a.id
FROM artifacts a
WHERE ael.artifact_id::uuid = a.id;

-- Drop old column and rename
ALTER TABLE artifact_entity_links 
  DROP COLUMN artifact_id;

ALTER TABLE artifact_entity_links 
  RENAME COLUMN artifact_id_new TO artifact_id;

-- Make NOT NULL
ALTER TABLE artifact_entity_links 
  ALTER COLUMN artifact_id SET NOT NULL;

-- Step 5: Convert entity_id from TEXT to UUID
-- Add new UUID column
ALTER TABLE artifact_entity_links 
  ADD COLUMN entity_id_new UUID;

-- Populate from entities table (entities.id is now UUID)
UPDATE artifact_entity_links ael
SET entity_id_new = e.id
FROM entities e
WHERE ael.entity_id::uuid = e.id;

-- Drop old column and rename
ALTER TABLE artifact_entity_links 
  DROP COLUMN entity_id;

ALTER TABLE artifact_entity_links 
  RENAME COLUMN entity_id_new TO entity_id;

-- Make NOT NULL
ALTER TABLE artifact_entity_links 
  ALTER COLUMN entity_id SET NOT NULL;

-- Step 6: Recreate unique constraint (allows multiple link types per artifact/entity pair)
ALTER TABLE artifact_entity_links 
  ADD CONSTRAINT artifact_entity_links_artifact_id_entity_id_link_type_key 
  UNIQUE (artifact_id, entity_id, link_type);

-- Step 7: Recreate foreign key constraints
ALTER TABLE artifact_entity_links 
  ADD CONSTRAINT artifact_entity_links_artifact_id_fkey 
  FOREIGN KEY (artifact_id) 
  REFERENCES artifacts(id) 
  ON DELETE CASCADE;

ALTER TABLE artifact_entity_links 
  ADD CONSTRAINT artifact_entity_links_entity_id_fkey 
  FOREIGN KEY (entity_id) 
  REFERENCES entities(id) 
  ON DELETE CASCADE;

-- Step 8: Recreate RLS policies
CREATE POLICY "Users can delete own artifact_entity_links"
  ON artifact_entity_links
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (EXISTS (
    SELECT 1
    FROM public.entities e
    WHERE e.id = artifact_entity_links.entity_id AND e.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert own artifact_entity_links"
  ON artifact_entity_links
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.entities e
      WHERE e.id = artifact_entity_links.entity_id AND e.user_id = auth.uid()
    ) AND EXISTS (
      SELECT 1
      FROM public.artifacts a
      WHERE a.id = artifact_entity_links.artifact_id AND a.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own artifact_entity_links"
  ON artifact_entity_links
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (EXISTS (
    SELECT 1
    FROM public.entities e
    WHERE e.id = artifact_entity_links.entity_id AND e.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.entities e
    WHERE e.id = artifact_entity_links.entity_id AND e.user_id = auth.uid()
  ));

CREATE POLICY "Users can view own artifact_entity_links"
  ON artifact_entity_links
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.entities e
      WHERE e.id = artifact_entity_links.entity_id AND e.user_id = auth.uid()
    ) OR EXISTS (
      SELECT 1
      FROM public.artifacts a
      WHERE a.id = artifact_entity_links.artifact_id AND a.user_id = auth.uid()
    )
  );

-- Migration complete: artifact_entity_links table updated with UUID foreign keys


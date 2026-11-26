-- Migration: Update artifacts table
-- 1. Change id from TEXT to UUID
-- 2. Add file_extension column
-- 3. Add content_type column
-- 4. Add file_metadata column
-- 5. Add updated_at column with auto-update trigger
-- 6. Update all foreign key references to use UUID

-- Step 1: Create a temporary mapping table to store old TEXT ids and new UUIDs
CREATE TEMP TABLE artifact_id_mapping (
  old_id TEXT PRIMARY KEY,
  new_id UUID NOT NULL DEFAULT gen_random_uuid()
);

-- Step 2: Generate UUIDs for all existing artifacts
INSERT INTO artifact_id_mapping (old_id)
SELECT id FROM artifacts
ON CONFLICT DO NOTHING;

-- Step 3: Add new UUID columns to all tables that reference artifacts.id
-- We'll populate these in the next step, then drop the old columns

-- artifact_entity_links
ALTER TABLE artifact_entity_links 
  ADD COLUMN artifact_id_new UUID;

-- artifacts (for previous_version_id self-reference)
ALTER TABLE artifacts 
  ADD COLUMN previous_version_id_new UUID;

-- derived_artifacts
ALTER TABLE derived_artifacts 
  ADD COLUMN source_artifact_id_new UUID;

-- events
ALTER TABLE events 
  ADD COLUMN source_artifact_id_new UUID;

-- system_decisions
ALTER TABLE system_decisions 
  ADD COLUMN artifact_id_new UUID;

-- user_tasks
ALTER TABLE user_tasks 
  ADD COLUMN source_artifact_id_new UUID;

-- workflow_runs
ALTER TABLE workflow_runs 
  ADD COLUMN source_artifact_id_new UUID;

-- Step 4: Populate the new UUID columns using the mapping table
UPDATE artifact_entity_links ael
SET artifact_id_new = aim.new_id
FROM artifact_id_mapping aim
WHERE ael.artifact_id = aim.old_id;

UPDATE artifacts a
SET previous_version_id_new = aim.new_id
FROM artifact_id_mapping aim
WHERE a.previous_version_id = aim.old_id;

UPDATE derived_artifacts da
SET source_artifact_id_new = aim.new_id
FROM artifact_id_mapping aim
WHERE da.source_artifact_id = aim.old_id;

UPDATE events e
SET source_artifact_id_new = aim.new_id
FROM artifact_id_mapping aim
WHERE e.source_artifact_id = aim.old_id;

UPDATE system_decisions sd
SET artifact_id_new = aim.new_id
FROM artifact_id_mapping aim
WHERE sd.artifact_id = aim.old_id;

UPDATE user_tasks ut
SET source_artifact_id_new = aim.new_id
FROM artifact_id_mapping aim
WHERE ut.source_artifact_id = aim.old_id;

UPDATE workflow_runs wr
SET source_artifact_id_new = aim.new_id
FROM artifact_id_mapping aim
WHERE wr.source_artifact_id = aim.old_id;

-- Step 5a: Drop RLS policies that reference artifact_id columns
-- artifact_entity_links policies
DROP POLICY IF EXISTS "Users can delete own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can insert own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can update own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can view own artifact_entity_links" ON artifact_entity_links;

-- derived_artifacts policies
DROP POLICY IF EXISTS "Users can view their own derived artifacts" ON derived_artifacts;

-- workflow_runs policies
DROP POLICY IF EXISTS "Users can view their own workflow runs" ON workflow_runs;

-- Step 5b: Drop foreign key constraints and unique constraints that reference artifact_id
ALTER TABLE artifact_entity_links 
  DROP CONSTRAINT IF EXISTS artifact_entity_links_artifact_id_fkey,
  DROP CONSTRAINT IF EXISTS artifact_entity_links_artifact_id_entity_id_link_type_key;

ALTER TABLE artifacts 
  DROP CONSTRAINT IF EXISTS artifacts_previous_version_id_fkey;

ALTER TABLE derived_artifacts 
  DROP CONSTRAINT IF EXISTS derived_artifacts_source_artifact_id_fkey,
  DROP CONSTRAINT IF EXISTS derived_artifacts_source_artifact_id_storage_path_key;

ALTER TABLE events 
  DROP CONSTRAINT IF EXISTS events_source_artifact_id_fkey;

ALTER TABLE system_decisions 
  DROP CONSTRAINT IF EXISTS system_decisions_artifact_id_fkey;

ALTER TABLE user_tasks 
  DROP CONSTRAINT IF EXISTS user_tasks_source_artifact_id_fkey;

ALTER TABLE workflow_runs 
  DROP CONSTRAINT IF EXISTS workflow_runs_source_artifact_id_fkey;

-- Step 6: Drop primary key constraint on artifacts
ALTER TABLE artifacts 
  DROP CONSTRAINT IF EXISTS artifacts_pkey;

-- Step 7: Drop old TEXT columns and rename new UUID columns
-- artifact_entity_links
ALTER TABLE artifact_entity_links 
  DROP COLUMN artifact_id;

ALTER TABLE artifact_entity_links 
  RENAME COLUMN artifact_id_new TO artifact_id;

ALTER TABLE artifact_entity_links 
  ALTER COLUMN artifact_id SET NOT NULL;

-- artifacts (for id and previous_version_id)
-- First, handle previous_version_id
ALTER TABLE artifacts 
  RENAME COLUMN previous_version_id TO previous_version_id_old;

ALTER TABLE artifacts 
  RENAME COLUMN previous_version_id_new TO previous_version_id;

-- Drop old previous_version_id column
ALTER TABLE artifacts 
  DROP COLUMN previous_version_id_old;

-- Now handle artifacts.id - add new UUID column
ALTER TABLE artifacts 
  ADD COLUMN id_new UUID;

-- Populate new UUID id column from mapping (id is TEXT, so direct comparison)
UPDATE artifacts a
SET id_new = aim.new_id
FROM artifact_id_mapping aim
WHERE a.id = aim.old_id;

-- Make id_new NOT NULL
ALTER TABLE artifacts 
  ALTER COLUMN id_new SET NOT NULL;

-- Drop old TEXT id column (all foreign keys have been updated already)
ALTER TABLE artifacts 
  DROP COLUMN id;

-- Rename id_new to id
ALTER TABLE artifacts 
  RENAME COLUMN id_new TO id;

-- Add primary key constraint
ALTER TABLE artifacts 
  ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

-- derived_artifacts
ALTER TABLE derived_artifacts 
  DROP COLUMN source_artifact_id;

ALTER TABLE derived_artifacts 
  RENAME COLUMN source_artifact_id_new TO source_artifact_id;

ALTER TABLE derived_artifacts 
  ALTER COLUMN source_artifact_id SET NOT NULL;

-- events
ALTER TABLE events 
  DROP COLUMN source_artifact_id;

ALTER TABLE events 
  RENAME COLUMN source_artifact_id_new TO source_artifact_id;

-- system_decisions
ALTER TABLE system_decisions 
  DROP COLUMN artifact_id;

ALTER TABLE system_decisions 
  RENAME COLUMN artifact_id_new TO artifact_id;

-- user_tasks
ALTER TABLE user_tasks 
  DROP COLUMN source_artifact_id;

ALTER TABLE user_tasks 
  RENAME COLUMN source_artifact_id_new TO source_artifact_id;

-- workflow_runs
ALTER TABLE workflow_runs 
  DROP COLUMN source_artifact_id;

ALTER TABLE workflow_runs 
  RENAME COLUMN source_artifact_id_new TO source_artifact_id;

-- Step 8: Recreate foreign key constraints and unique constraints
ALTER TABLE artifact_entity_links 
  ADD CONSTRAINT artifact_entity_links_artifact_id_fkey 
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  ADD CONSTRAINT artifact_entity_links_artifact_id_entity_id_link_type_key 
  UNIQUE (artifact_id, entity_id, link_type);

ALTER TABLE artifacts 
  ADD CONSTRAINT artifacts_previous_version_id_fkey 
  FOREIGN KEY (previous_version_id) REFERENCES artifacts(id);

ALTER TABLE derived_artifacts 
  ADD CONSTRAINT derived_artifacts_source_artifact_id_fkey 
  FOREIGN KEY (source_artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  ADD CONSTRAINT derived_artifacts_source_artifact_id_storage_path_key 
  UNIQUE (source_artifact_id, storage_path);

ALTER TABLE events 
  ADD CONSTRAINT events_source_artifact_id_fkey 
  FOREIGN KEY (source_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL;

ALTER TABLE system_decisions 
  ADD CONSTRAINT system_decisions_artifact_id_fkey 
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE;

ALTER TABLE user_tasks 
  ADD CONSTRAINT user_tasks_source_artifact_id_fkey 
  FOREIGN KEY (source_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL;

ALTER TABLE workflow_runs 
  ADD CONSTRAINT workflow_runs_source_artifact_id_fkey 
  FOREIGN KEY (source_artifact_id) REFERENCES artifacts(id);

-- Step 9: Add file_extension column
ALTER TABLE artifacts 
  ADD COLUMN file_extension TEXT;

-- Step 10: Add content_type column (MIME type - can be same as file_type or separate)
ALTER TABLE artifacts 
  ADD COLUMN content_type TEXT;

-- Step 11: Add file_metadata column
-- NOTE: file_metadata and processing_metadata are DIFFERENT:
--   - file_metadata: General file properties (dimensions, encoding, format details, etc.)
--   - processing_metadata: Workflow/processing-specific metadata (extraction results, AI analysis, etc.)
ALTER TABLE artifacts 
  ADD COLUMN file_metadata JSONB DEFAULT '{}'::jsonb;

-- Step 12: Add updated_at column
ALTER TABLE artifacts 
  ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

-- Step 13: Create function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 14: Create trigger to auto-update updated_at
CREATE TRIGGER update_artifacts_updated_at
  BEFORE UPDATE ON artifacts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Step 15: Update file_extension from filename for existing records
UPDATE artifacts
SET file_extension = 
  CASE 
    WHEN filename LIKE '%.%' THEN 
      LOWER(SUBSTRING(filename FROM '\.([^.]+)$'))
    ELSE NULL
  END
WHERE file_extension IS NULL;

-- Step 16: Populate content_type from file_type for existing records (if file_type exists)
UPDATE artifacts
SET content_type = file_type
WHERE content_type IS NULL AND file_type IS NOT NULL;

-- Step 17: Recreate RLS policies that were dropped
-- artifact_entity_links policies
CREATE POLICY "Users can delete own artifact_entity_links"
ON artifact_entity_links
AS PERMISSIVE
FOR DELETE
TO public
USING ((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))));

CREATE POLICY "Users can insert own artifact_entity_links"
ON artifact_entity_links
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))) AND (EXISTS ( SELECT 1
   FROM artifacts a
  WHERE ((a.id = artifact_entity_links.artifact_id) AND (a.user_id = auth.uid()))))));

CREATE POLICY "Users can update own artifact_entity_links"
ON artifact_entity_links
AS PERMISSIVE
FOR UPDATE
TO public
USING ((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))))
WITH CHECK ((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))));

CREATE POLICY "Users can view own artifact_entity_links"
ON artifact_entity_links
AS PERMISSIVE
FOR SELECT
TO public
USING (((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM artifacts a
  WHERE ((a.id = artifact_entity_links.artifact_id) AND (a.user_id = auth.uid()))))));

-- derived_artifacts policy
CREATE POLICY "Users can view their own derived artifacts"
ON derived_artifacts
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM artifacts a
  WHERE ((a.id = derived_artifacts.source_artifact_id) AND (a.user_id = auth.uid()))))));

-- workflow_runs policy
CREATE POLICY "Users can view their own workflow runs"
ON workflow_runs
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM artifacts a
  WHERE ((a.id = workflow_runs.source_artifact_id) AND (a.user_id = auth.uid()))))));

-- Clean up: Drop temporary mapping table (it's TEMP so will be dropped automatically)
-- But let's be explicit
DROP TABLE IF EXISTS artifact_id_mapping;


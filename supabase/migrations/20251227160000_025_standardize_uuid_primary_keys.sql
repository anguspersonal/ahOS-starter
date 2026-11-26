-- Migration: Standardize UUID primary keys across all tables
-- 
-- This migration ensures all tables use UUID primary keys with database-generated defaults.
-- 
-- Best Practice: Database should always handle UUID generation for:
-- 1. Consistency - All UUIDs generated the same way (gen_random_uuid)
-- 2. Atomicity - ID created within the same transaction as the insert
-- 3. Source independence - Works for any insert source (code, SQL, migrations)
-- 4. Simpler code - No UUID imports needed in application code
--
-- Tables addressed:
-- - artifacts: Converted TEXT→UUID in 010, missing default
-- - entities: Converted TEXT→UUID in 011, missing default
-- - workflows: Converted TEXT→UUID in 012, missing default
-- - discovered_patterns: Still TEXT, needs full conversion
-- - training_examples: Still TEXT, needs full conversion

-- ============================================================================
-- PART 1: Add defaults to tables already converted to UUID
-- ============================================================================

-- artifacts (converted in migration 010)
ALTER TABLE artifacts 
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- entities (converted in migration 011)
ALTER TABLE entities 
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- workflows (renamed from workflow_runs in migration 012)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflows' AND table_schema = 'public') THEN
    EXECUTE 'ALTER TABLE workflows ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_runs' AND table_schema = 'public') THEN
    EXECUTE 'ALTER TABLE workflow_runs ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  END IF;
END $$;

-- ============================================================================
-- PART 2: Convert discovered_patterns from TEXT to UUID
-- ============================================================================

-- Step 2.1: Create mapping table for discovered_patterns
CREATE TEMP TABLE discovered_patterns_id_mapping (
  old_id TEXT PRIMARY KEY,
  new_id UUID NOT NULL DEFAULT gen_random_uuid()
);

-- Step 2.2: Populate mapping with existing IDs
INSERT INTO discovered_patterns_id_mapping (old_id)
SELECT id FROM discovered_patterns
ON CONFLICT DO NOTHING;

-- Step 2.3: Add new UUID column
ALTER TABLE discovered_patterns ADD COLUMN id_new UUID;

-- Step 2.4: Populate new column from mapping
UPDATE discovered_patterns dp
SET id_new = m.new_id
FROM discovered_patterns_id_mapping m
WHERE dp.id = m.old_id;

-- Step 2.5: For any rows without mapping (shouldn't happen), generate new UUID
UPDATE discovered_patterns
SET id_new = gen_random_uuid()
WHERE id_new IS NULL;

-- Step 2.6: Make new column NOT NULL
ALTER TABLE discovered_patterns ALTER COLUMN id_new SET NOT NULL;

-- Step 2.7: Drop old primary key and column
ALTER TABLE discovered_patterns DROP CONSTRAINT IF EXISTS discovered_patterns_pkey;
ALTER TABLE discovered_patterns DROP COLUMN id;

-- Step 2.8: Rename and add primary key with default
ALTER TABLE discovered_patterns RENAME COLUMN id_new TO id;
ALTER TABLE discovered_patterns ADD CONSTRAINT discovered_patterns_pkey PRIMARY KEY (id);
ALTER TABLE discovered_patterns ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Cleanup
DROP TABLE discovered_patterns_id_mapping;

-- ============================================================================
-- PART 3: Convert training_examples from TEXT to UUID
-- ============================================================================

-- Step 3.1: Handle self-reference (superseded_by column)
-- First, create mapping table
CREATE TEMP TABLE training_examples_id_mapping (
  old_id TEXT PRIMARY KEY,
  new_id UUID NOT NULL DEFAULT gen_random_uuid()
);

-- Step 3.2: Populate mapping
INSERT INTO training_examples_id_mapping (old_id)
SELECT id FROM training_examples
ON CONFLICT DO NOTHING;

-- Step 3.3: Drop self-referential foreign key constraint
ALTER TABLE training_examples 
  DROP CONSTRAINT IF EXISTS training_examples_superseded_by_fkey;

-- Step 3.4: Add new UUID columns for id and superseded_by
ALTER TABLE training_examples ADD COLUMN id_new UUID;
ALTER TABLE training_examples ADD COLUMN superseded_by_new UUID;

-- Step 3.5: Populate new id column from mapping
UPDATE training_examples te
SET id_new = m.new_id
FROM training_examples_id_mapping m
WHERE te.id = m.old_id;

-- Step 3.6: Populate superseded_by_new from mapping
UPDATE training_examples te
SET superseded_by_new = m.new_id
FROM training_examples_id_mapping m
WHERE te.superseded_by = m.old_id;

-- Step 3.7: Handle any unmapped rows
UPDATE training_examples
SET id_new = gen_random_uuid()
WHERE id_new IS NULL;

-- Step 3.8: Make id_new NOT NULL
ALTER TABLE training_examples ALTER COLUMN id_new SET NOT NULL;

-- Step 3.9: Drop old columns and constraints
ALTER TABLE training_examples DROP CONSTRAINT IF EXISTS training_examples_pkey;
ALTER TABLE training_examples DROP COLUMN id;
ALTER TABLE training_examples DROP COLUMN superseded_by;

-- Step 3.10: Rename columns
ALTER TABLE training_examples RENAME COLUMN id_new TO id;
ALTER TABLE training_examples RENAME COLUMN superseded_by_new TO superseded_by;

-- Step 3.11: Add primary key and default
ALTER TABLE training_examples ADD CONSTRAINT training_examples_pkey PRIMARY KEY (id);
ALTER TABLE training_examples ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Step 3.12: Recreate self-referential foreign key
ALTER TABLE training_examples
  ADD CONSTRAINT training_examples_superseded_by_fkey 
  FOREIGN KEY (superseded_by) REFERENCES training_examples(id);

-- Cleanup
DROP TABLE training_examples_id_mapping;

-- ============================================================================
-- PART 4: Add comments documenting the standard
-- ============================================================================

COMMENT ON COLUMN artifacts.id IS 'Primary key - UUID auto-generated by database';
COMMENT ON COLUMN entities.id IS 'Primary key - UUID auto-generated by database';
COMMENT ON COLUMN discovered_patterns.id IS 'Primary key - UUID auto-generated by database';
COMMENT ON COLUMN training_examples.id IS 'Primary key - UUID auto-generated by database';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflows' AND table_schema = 'public') THEN
    EXECUTE 'COMMENT ON COLUMN workflows.id IS ''Primary key - UUID auto-generated by database''';
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_runs' AND table_schema = 'public') THEN
    EXECUTE 'COMMENT ON COLUMN workflow_runs.id IS ''Primary key - UUID auto-generated by database''';
  END IF;
END $$;


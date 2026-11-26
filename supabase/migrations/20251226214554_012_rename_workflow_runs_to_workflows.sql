-- Migration: Rename workflow_runs to workflows, convert id to UUID, add missing fields
-- Date: 2025-12-26

-- Step 1: Drop views that depend on workflow_runs or related tables
DROP VIEW IF EXISTS public.active_workflows;
DROP VIEW IF EXISTS public.gold_examples;

-- Step 2: Drop RLS policies
DROP POLICY IF EXISTS "Users can view their own workflow runs" ON workflow_runs;

-- Step 3: Drop foreign key constraints from referencing tables
ALTER TABLE artifacts 
  DROP CONSTRAINT IF EXISTS artifacts_workflow_run_id_fkey;

ALTER TABLE tasks 
  DROP CONSTRAINT IF EXISTS tasks_workflow_run_id_fkey;

ALTER TABLE training_examples 
  DROP CONSTRAINT IF EXISTS training_examples_source_workflow_run_id_fkey;

-- Step 4: Create temporary mapping table for id conversion
CREATE TEMP TABLE workflow_id_mapping (
  old_id TEXT NOT NULL,
  new_id UUID NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (old_id)
);

-- Step 5: Populate mapping table with new UUIDs
INSERT INTO workflow_id_mapping (old_id)
SELECT DISTINCT id FROM workflow_runs WHERE id IS NOT NULL;

-- Step 6: Add new UUID column to workflow_runs
ALTER TABLE workflow_runs 
  ADD COLUMN id_new UUID;

-- Step 7: Populate new UUID column from mapping
UPDATE workflow_runs wr
SET id_new = wim.new_id
FROM workflow_id_mapping wim
WHERE wr.id = wim.old_id;

-- Step 8: Update referencing tables with new UUIDs
-- artifacts.workflow_run_id
ALTER TABLE artifacts 
  ADD COLUMN workflow_run_id_new UUID;

UPDATE artifacts a
SET workflow_run_id_new = wim.new_id
FROM workflow_id_mapping wim
WHERE a.workflow_run_id = wim.old_id;

-- tasks.workflow_run_id
ALTER TABLE tasks 
  ADD COLUMN workflow_run_id_new UUID;

UPDATE tasks t
SET workflow_run_id_new = wim.new_id
FROM workflow_id_mapping wim
WHERE t.workflow_run_id = wim.old_id;

-- training_examples.source_workflow_run_id
ALTER TABLE training_examples 
  ADD COLUMN source_workflow_run_id_new UUID;

UPDATE training_examples te
SET source_workflow_run_id_new = wim.new_id
FROM workflow_id_mapping wim
WHERE te.source_workflow_run_id = wim.old_id;

-- derived_artifacts.workflow_run_id (check if it's UUID or TEXT)
-- If it's UUID, we need to convert it; if TEXT, we update it
-- Let's check and handle both cases
DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'derived_artifacts'
    AND column_name = 'workflow_run_id';
  
  IF col_type = 'uuid' THEN
    -- Already UUID, just update the values
    UPDATE derived_artifacts da
    SET workflow_run_id = wim.new_id
    FROM workflow_id_mapping wim
    WHERE da.workflow_run_id::text = wim.old_id;
  ELSIF col_type = 'text' THEN
    -- TEXT, need to convert
    ALTER TABLE derived_artifacts 
      ADD COLUMN workflow_run_id_new UUID;
    
    UPDATE derived_artifacts da
    SET workflow_run_id_new = wim.new_id
    FROM workflow_id_mapping wim
    WHERE da.workflow_run_id = wim.old_id;
    
    ALTER TABLE derived_artifacts 
      DROP COLUMN workflow_run_id;
    
    ALTER TABLE derived_artifacts 
      RENAME COLUMN workflow_run_id_new TO workflow_run_id;
  END IF;
END $$;

-- Step 9: Drop old primary key constraint
ALTER TABLE workflow_runs 
  DROP CONSTRAINT IF EXISTS workflow_runs_pkey;

-- Step 10: Drop old TEXT columns and rename new UUID columns
-- artifacts
ALTER TABLE artifacts 
  DROP COLUMN workflow_run_id;

ALTER TABLE artifacts 
  RENAME COLUMN workflow_run_id_new TO workflow_run_id;

-- tasks
ALTER TABLE tasks 
  DROP COLUMN workflow_run_id;

ALTER TABLE tasks 
  RENAME COLUMN workflow_run_id_new TO workflow_run_id;

-- training_examples
ALTER TABLE training_examples 
  DROP COLUMN source_workflow_run_id;

ALTER TABLE training_examples 
  RENAME COLUMN source_workflow_run_id_new TO source_workflow_run_id;

-- workflow_runs
ALTER TABLE workflow_runs 
  DROP COLUMN id;

ALTER TABLE workflow_runs 
  RENAME COLUMN id_new TO id;

ALTER TABLE workflow_runs 
  ALTER COLUMN id SET NOT NULL;

-- Step 11: Add new primary key
ALTER TABLE workflow_runs 
  ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);

-- Step 12: Convert source_artifact_id from TEXT to UUID
-- First, add new UUID column
ALTER TABLE workflow_runs 
  ADD COLUMN source_artifact_id_new UUID;

-- Populate from artifacts table (since artifacts.id is now UUID)
-- Try to match TEXT source_artifact_id with UUID artifacts.id
UPDATE workflow_runs wr
SET source_artifact_id_new = a.id
FROM artifacts a
WHERE wr.source_artifact_id::uuid = a.id;

-- Drop old column and rename
ALTER TABLE workflow_runs 
  DROP COLUMN source_artifact_id;

ALTER TABLE workflow_runs 
  RENAME COLUMN source_artifact_id_new TO source_artifact_id;

-- Step 13: Add missing fields
ALTER TABLE workflow_runs 
  ADD COLUMN tokens_used INTEGER DEFAULT 0;

ALTER TABLE workflow_runs 
  ADD COLUMN last_message TEXT;

ALTER TABLE workflow_runs 
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE workflow_runs 
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Step 14: Add defaults to existing fields
ALTER TABLE workflow_runs 
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

UPDATE workflow_runs 
SET metadata = '{}'::jsonb 
WHERE metadata IS NULL;

ALTER TABLE workflow_runs 
  ALTER COLUMN execution_mode SET DEFAULT 'automatic';

UPDATE workflow_runs 
SET execution_mode = 'automatic' 
WHERE execution_mode IS NULL;

-- Step 15: Update status default to 'pending' (or keep 'in_progress' - keeping 'in_progress' for now)
-- Note: The actual schema has 'in_progress' as default, but planned has 'pending'
-- We'll keep 'in_progress' to match actual behavior, but can change if needed

-- Step 16: Create function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_workflows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 17: Create trigger to auto-update updated_at
CREATE TRIGGER update_workflows_updated_at
  BEFORE UPDATE ON workflow_runs
  FOR EACH ROW
  EXECUTE FUNCTION update_workflows_updated_at();

-- Step 18: Rename table from workflow_runs to workflows
ALTER TABLE workflow_runs 
  RENAME TO workflows;

-- Step 19: Recreate foreign key constraints
ALTER TABLE artifacts 
  ADD CONSTRAINT artifacts_workflow_id_fkey 
  FOREIGN KEY (workflow_run_id) 
  REFERENCES workflows(id) 
  ON DELETE SET NULL;

ALTER TABLE tasks 
  ADD CONSTRAINT tasks_workflow_id_fkey 
  FOREIGN KEY (workflow_run_id) 
  REFERENCES workflows(id) 
  ON DELETE CASCADE;

ALTER TABLE training_examples 
  ADD CONSTRAINT training_examples_source_workflow_id_fkey 
  FOREIGN KEY (source_workflow_run_id) 
  REFERENCES workflows(id) 
  ON DELETE SET NULL;

ALTER TABLE workflows 
  ADD CONSTRAINT workflows_source_artifact_id_fkey 
  FOREIGN KEY (source_artifact_id) 
  REFERENCES artifacts(id) 
  ON DELETE SET NULL;

ALTER TABLE workflows 
  ADD CONSTRAINT workflows_team_id_fkey 
  FOREIGN KEY (team_id) 
  REFERENCES teams(id) 
  ON DELETE SET NULL;

ALTER TABLE workflows 
  ADD CONSTRAINT workflows_user_id_fkey 
  FOREIGN KEY (user_id) 
  REFERENCES auth.users(id) 
  ON DELETE CASCADE;

-- Step 20: Recreate check constraints
ALTER TABLE workflows 
  ADD CONSTRAINT valid_workflow_status 
  CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled', 'awaiting_user'));

-- Step 21: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_workflows_user_id ON workflows(user_id);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_team_id ON workflows(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflows_type ON workflows(workflow_type);
CREATE INDEX IF NOT EXISTS idx_workflows_started_at ON workflows(started_at);
CREATE INDEX IF NOT EXISTS idx_workflows_created_at ON workflows(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_updated_at ON workflows(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_source_artifact_id ON workflows(source_artifact_id) WHERE source_artifact_id IS NOT NULL;

-- Update existing indexes on referencing tables
DROP INDEX IF EXISTS idx_artifacts_workflow_run;
CREATE INDEX IF NOT EXISTS idx_artifacts_workflow_id ON artifacts(workflow_run_id) WHERE workflow_run_id IS NOT NULL;

DROP INDEX IF EXISTS idx_tasks_workflow_run_id;
CREATE INDEX IF NOT EXISTS idx_tasks_workflow_id ON tasks(workflow_run_id) WHERE workflow_run_id IS NOT NULL;

DROP INDEX IF EXISTS idx_training_examples_source_workflow;
CREATE INDEX IF NOT EXISTS idx_training_examples_source_workflow_id ON training_examples(source_workflow_run_id) WHERE source_workflow_run_id IS NOT NULL;

DROP INDEX IF EXISTS idx_derived_artifacts_workflow;
CREATE INDEX IF NOT EXISTS idx_derived_artifacts_workflow_id ON derived_artifacts(workflow_run_id) WHERE workflow_run_id IS NOT NULL;

-- Step 22: Recreate view active_workflows
CREATE OR REPLACE VIEW public.active_workflows AS
  SELECT 
    wr.id,
    wr.workflow_type,
    wr.status,
    wr.metadata,
    wr.started_at,
    wr.completed_at,
    wr.executed_by,
    wr.execution_mode,
    count(t.id) AS total_tasks,
    sum(
        CASE
            WHEN (t.status = 'completed'::text) THEN 1
            ELSE 0
        END) AS completed_tasks,
    sum(
        CASE
            WHEN (t.status = 'failed'::text) THEN 1
            ELSE 0
        END) AS failed_tasks
   FROM (public.workflows wr
     LEFT JOIN public.tasks t ON ((wr.id = t.workflow_run_id)))
  WHERE (wr.status = 'in_progress'::text)
  GROUP BY wr.id;

-- Step 23: Recreate RLS policies
CREATE POLICY "Users can view their own workflows"
ON workflows
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.artifacts a
  WHERE ((a.id = workflows.source_artifact_id) AND (a.user_id = auth.uid()))))));

-- Step 24: Recreate gold_examples view
CREATE OR REPLACE VIEW public.gold_examples AS
  SELECT 
    id,
    example_type,
    source_workflow_run_id,
    source_task_id,
    input,
    output,
    ground_truth,
    context_needed,
    pattern_category,
    pattern_notes,
    difficulties,
    decision_rationale,
    tags,
    domain,
    quality_tier,
    is_validated,
    validated_by,
    validated_at,
    embedding,
    version,
    superseded_by,
    created_at,
    updated_at
   FROM public.training_examples
  WHERE (quality_tier = 'gold'::text);

-- Step 25: Clean up temporary mapping table
DROP TABLE IF EXISTS workflow_id_mapping;


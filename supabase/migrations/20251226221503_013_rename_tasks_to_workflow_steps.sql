-- Migration: Rename tasks to workflow_steps, convert workflow_run_id to workflow_id UUID, rename task fields to step fields
-- Date: 2025-12-26

-- Step 1: Drop view that depends on tasks
DROP VIEW IF EXISTS public.active_workflows;

-- Step 2: Drop RLS policies on tasks table
DROP POLICY IF EXISTS "Users can view own workflow tasks" ON tasks;
DROP POLICY IF EXISTS "Users can insert own workflow tasks" ON tasks;
DROP POLICY IF EXISTS "Users can update own workflow tasks" ON tasks;
DROP POLICY IF EXISTS "Users can delete own workflow tasks" ON tasks;

-- Step 3: Drop foreign key constraints from referencing tables
ALTER TABLE system_decisions 
  DROP CONSTRAINT IF EXISTS system_decisions_workflow_task_id_fkey;

ALTER TABLE training_examples 
  DROP CONSTRAINT IF EXISTS training_examples_source_task_id_fkey;

-- Note: derived_artifacts.task_id is TEXT, not a foreign key, so we'll handle it separately

-- Step 4: Add new UUID column for workflow_id
ALTER TABLE tasks 
  ADD COLUMN workflow_id_new UUID;

-- Step 5: Populate new workflow_id column directly from workflows table
-- Convert TEXT workflow_run_id to UUID by joining with workflows
UPDATE tasks t
SET workflow_id_new = w.id
FROM workflows w
WHERE t.workflow_run_id::uuid = w.id;

-- Step 8: Add new fields that are missing
ALTER TABLE tasks 
  ADD COLUMN message TEXT,
  ADD COLUMN system_job_id UUID,
  ADD COLUMN notification_id UUID;

-- Step 9: Rename columns: task_type -> step_type, task_name -> step_name, task_order -> step_order
ALTER TABLE tasks 
  RENAME COLUMN task_type TO step_type;

ALTER TABLE tasks 
  RENAME COLUMN task_name TO step_name;

ALTER TABLE tasks 
  RENAME COLUMN task_order TO step_order;

-- Step 10: Make step_name and step_order NOT NULL (update existing NULLs first)
UPDATE tasks 
SET step_name = COALESCE(step_name, 'unnamed_step')
WHERE step_name IS NULL;

UPDATE tasks 
SET step_order = COALESCE(step_order, 0)
WHERE step_order IS NULL;

ALTER TABLE tasks 
  ALTER COLUMN step_name SET NOT NULL,
  ALTER COLUMN step_order SET NOT NULL;

-- Step 11: Drop old foreign key constraint
ALTER TABLE tasks 
  DROP CONSTRAINT IF EXISTS tasks_workflow_run_id_fkey;

-- Step 12: Drop old TEXT column and rename new UUID column
ALTER TABLE tasks 
  DROP COLUMN workflow_run_id;

ALTER TABLE tasks 
  RENAME COLUMN workflow_id_new TO workflow_id;

ALTER TABLE tasks 
  ALTER COLUMN workflow_id SET NOT NULL;

-- Step 13: Rename table from tasks to workflow_steps
ALTER TABLE tasks 
  RENAME TO workflow_steps;

-- Step 14: Recreate foreign key constraint
ALTER TABLE workflow_steps 
  ADD CONSTRAINT workflow_steps_workflow_id_fkey 
  FOREIGN KEY (workflow_id) 
  REFERENCES workflows(id) 
  ON DELETE CASCADE;

-- Step 15: Update foreign key references in other tables
-- system_decisions.workflow_task_id (bigint) - no change needed, just update constraint
ALTER TABLE system_decisions 
  ADD CONSTRAINT system_decisions_workflow_step_id_fkey 
  FOREIGN KEY (workflow_task_id) 
  REFERENCES workflow_steps(id) 
  ON DELETE SET NULL;

-- training_examples.source_task_id (bigint) - no change needed, just update constraint
ALTER TABLE training_examples 
  ADD CONSTRAINT training_examples_source_step_id_fkey 
  FOREIGN KEY (source_task_id) 
  REFERENCES workflow_steps(id) 
  ON DELETE SET NULL;

-- Note: derived_artifacts.task_id is TEXT, not a foreign key, so we'll convert it to bigint if needed
-- For now, we'll leave it as TEXT since it might store non-numeric task identifiers

-- Step 16: Recreate check constraint with updated name
ALTER TABLE workflow_steps 
  DROP CONSTRAINT IF EXISTS valid_task_status;

ALTER TABLE workflow_steps 
  ADD CONSTRAINT valid_step_status 
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped'));

-- Step 17: Recreate indexes with new names
DROP INDEX IF EXISTS idx_tasks_workflow_run_id;
DROP INDEX IF EXISTS idx_tasks_status;
DROP INDEX IF EXISTS idx_tasks_task_order;

CREATE INDEX idx_workflow_steps_workflow_id ON workflow_steps(workflow_id) WHERE workflow_id IS NOT NULL;
CREATE INDEX idx_workflow_steps_status ON workflow_steps(status);
CREATE INDEX idx_workflow_steps_step_order ON workflow_steps(workflow_id, step_order);

-- Update index on system_decisions
DROP INDEX IF EXISTS idx_system_decisions_workflow_task;
CREATE INDEX idx_system_decisions_workflow_step_id ON system_decisions(workflow_task_id) WHERE workflow_task_id IS NOT NULL;

-- Step 18: Recreate view active_workflows
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
    count(ws.id) AS total_steps,
    sum(
        CASE
            WHEN (ws.status = 'completed'::text) THEN 1
            ELSE 0
        END) AS completed_steps,
    sum(
        CASE
            WHEN (ws.status = 'failed'::text) THEN 1
            ELSE 0
        END) AS failed_steps
   FROM (public.workflows wr
     LEFT JOIN public.workflow_steps ws ON ((wr.id = ws.workflow_id)))
  WHERE (wr.status = 'in_progress'::text)
  GROUP BY wr.id, wr.workflow_type, wr.status, wr.metadata, wr.started_at, wr.completed_at, wr.executed_by, wr.execution_mode;

-- Step 19: Recreate RLS policies
CREATE POLICY "Users can view own workflow steps"
ON workflow_steps
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM workflows
        WHERE workflows.id = workflow_steps.workflow_id
        AND workflows.user_id = auth.uid()
    )
);

CREATE POLICY "Users can insert own workflow steps"
ON workflow_steps
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
    EXISTS (
        SELECT 1 FROM workflows
        WHERE workflows.id = workflow_steps.workflow_id
        AND workflows.user_id = auth.uid()
    )
);

CREATE POLICY "Users can update own workflow steps"
ON workflow_steps
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM workflows
        WHERE workflows.id = workflow_steps.workflow_id
        AND workflows.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM workflows
        WHERE workflows.id = workflow_steps.workflow_id
        AND workflows.user_id = auth.uid()
    )
);

CREATE POLICY "Users can delete own workflow steps"
ON workflow_steps
AS PERMISSIVE
FOR DELETE
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM workflows
        WHERE workflows.id = workflow_steps.workflow_id
        AND workflows.user_id = auth.uid()
    )
);

-- Migration complete: tasks table renamed to workflow_steps with all field updates


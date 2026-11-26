-- Migration: Add 'partial' to valid workflow statuses
-- Description: The workflow orchestrator uses 'partial' status when some steps are skipped (e.g. not implemented yet).
-- This migration updates the check constraint on the workflows table to allow this status.

-- Drop possible constraint names
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS valid_workflow_status;

-- Add updated constraint with 'partial' included
ALTER TABLE workflows 
  ADD CONSTRAINT valid_status 
  CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled', 'awaiting_user', 'partial'));

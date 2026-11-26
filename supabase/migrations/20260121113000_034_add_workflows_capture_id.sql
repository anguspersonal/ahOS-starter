-- Migration: Add workflows.capture_id for idempotent capture
-- Date: 2026-01-21
-- Purpose: Persist a client-provided idempotency key per workflow to prevent duplicate inbox items

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS capture_id text;

-- Uniqueness per user to prevent duplicates on retries/double-submits
CREATE UNIQUE INDEX IF NOT EXISTS workflows_user_capture_id_unique
  ON public.workflows (user_id, capture_id)
  WHERE capture_id IS NOT NULL;


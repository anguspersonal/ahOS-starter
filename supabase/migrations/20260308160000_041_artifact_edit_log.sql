-- Migration: Log artifact updates to artifact_edit_log
-- Date: 2026-03-08
-- Purpose: Audit trail when artifacts are updated (e.g. title, description, tags).
-- Trigger runs AFTER UPDATE on artifacts; logs only changed, user-relevant columns.

BEGIN;

-- Table: one row per artifact update, with before/after for tracked columns
CREATE TABLE public.artifact_edit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES public.artifacts(id) ON DELETE CASCADE,
  edited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  old_values JSONB NOT NULL DEFAULT '{}',
  new_values JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.artifact_edit_log IS 'Audit log of artifact row updates; populated by trigger on artifacts.';
COMMENT ON COLUMN public.artifact_edit_log.edited_by IS 'User who performed the update (auth.uid()), or NULL when updated by service role / worker.';

-- Indexes for common queries
CREATE INDEX idx_artifact_edit_log_artifact_id ON public.artifact_edit_log(artifact_id);
CREATE INDEX idx_artifact_edit_log_edited_by ON public.artifact_edit_log(edited_by);
CREATE INDEX idx_artifact_edit_log_created_at ON public.artifact_edit_log(created_at DESC);

-- RLS: only artifact owner (or team) can read their edit log; insert is done by trigger only
ALTER TABLE public.artifact_edit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view artifact_edit_log for own artifacts"
  ON public.artifact_edit_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.artifacts a
      WHERE a.id = artifact_edit_log.artifact_id AND a.user_id = auth.uid()
    )
  );

-- Trigger function: compare OLD and NEW for tracked columns, insert one row if any changed
CREATE OR REPLACE FUNCTION public.log_artifact_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tracked_cols TEXT[] := ARRAY[
    'title', 'description', 'tags', 'lifecycle_stage', 'processing_status',
    'archived', 'archived_at', 'archived_reason'
  ];
  col_name TEXT;
  old_json jsonb;
  new_json jsonb;
  changed_fields TEXT[] := '{}';
  old_vals jsonb := '{}';
  new_vals jsonb := '{}';
BEGIN
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);

  FOREACH col_name IN ARRAY tracked_cols
  LOOP
    IF (old_json -> col_name) IS DISTINCT FROM (new_json -> col_name) THEN
      changed_fields := array_append(changed_fields, col_name);
      old_vals := old_vals || jsonb_build_object(col_name, old_json -> col_name);
      new_vals := new_vals || jsonb_build_object(col_name, new_json -> col_name);
    END IF;
  END LOOP;

  IF array_length(changed_fields, 1) > 0 THEN
    INSERT INTO public.artifact_edit_log (artifact_id, edited_by, changed_fields, old_values, new_values)
    VALUES (NEW.id, auth.uid(), changed_fields, old_vals, new_vals);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_log_artifact_edit
  AFTER UPDATE ON public.artifacts
  FOR EACH ROW
  EXECUTE FUNCTION public.log_artifact_edit();

COMMIT;

-- Migration complete: artifact updates are logged to artifact_edit_log

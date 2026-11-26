-- Migration 148: Orthogonal task and actionable-entity dimensions alongside priority_level
-- Issue: #2074
-- Refs:  ADR-117 (orthogonal task and actionable-entity dimensions and DimensionTerm contract)
--        ADR-116 (universal 7-point priority scale 1 lowest to 7 highest)

SET statement_timeout = '15s';

-- 1. Enrich public.priority_levels with uniform DimensionTerm columns (slug, display, meaning)
ALTER TABLE public.priority_levels
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS display text,
  ADD COLUMN IF NOT EXISTS meaning text;

UPDATE public.priority_levels
SET
  slug = CASE level
    WHEN 1 THEN 'trivial'
    WHEN 2 THEN 'minor'
    WHEN 3 THEN 'low'
    WHEN 4 THEN 'normal'
    WHEN 5 THEN 'high'
    WHEN 6 THEN 'urgent'
    WHEN 7 THEN 'critical'
  END,
  display = title,
  meaning = description;

ALTER TABLE public.priority_levels
  ALTER COLUMN slug SET NOT NULL,
  ALTER COLUMN display SET NOT NULL,
  ALTER COLUMN meaning SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'priority_levels_slug_key'
      AND conrelid = 'public.priority_levels'::regclass
  ) THEN
    ALTER TABLE public.priority_levels
      ADD CONSTRAINT priority_levels_slug_key UNIQUE (slug);
  END IF;
END
$$;

COMMENT ON COLUMN public.priority_levels.slug IS
  'Canonical snake_case slug for the priority level (trivial, minor, low, normal, high, urgent, critical; ADR-116, ADR-117).';
COMMENT ON COLUMN public.priority_levels.display IS
  'Human-readable display title for the priority level (Trivial .. Critical; ADR-116, ADR-117).';
COMMENT ON COLUMN public.priority_levels.meaning IS
  'Operational definition for the priority level (ADR-116, ADR-117).';

-- 2. Expand public.user_tasks.status to the 7-state lifecycle vocabulary
ALTER TABLE public.user_tasks
  DROP CONSTRAINT IF EXISTS user_tasks_status_check;

ALTER TABLE public.user_tasks
  ADD CONSTRAINT user_tasks_status_check
  CHECK (status IN ('proposed', 'someday', 'todo', 'in_progress', 'blocked', 'done', 'cancelled'));

COMMENT ON COLUMN public.user_tasks.status IS
  'Canonical 7-state task lifecycle slug (proposed, someday, todo, in_progress, blocked, done, cancelled; default todo; ADR-117).';

-- 3. Add orthogonal task dimensions (task_type, recurrence_rule, effort, energy_mode, source)
ALTER TABLE public.user_tasks
  ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'one_off'
    CHECK (task_type IN ('one_off', 'recurring', 'habit', 'milestone')),
  ADD COLUMN IF NOT EXISTS recurrence_rule text,
  ADD COLUMN IF NOT EXISTS effort text
    CHECK (effort IS NULL OR effort IN ('quick', 'small', 'medium', 'large')),
  ADD COLUMN IF NOT EXISTS energy_mode text
    CHECK (energy_mode IS NULL OR energy_mode IN ('deep_work', 'admin', 'waiting_on', 'quick_win')),
  ADD COLUMN IF NOT EXISTS source text
    CHECK (source IS NULL OR source IN ('owner', 'agent_proposed', 'email_triage', 'meeting_sweep', 'ritual'));

COMMENT ON COLUMN public.user_tasks.task_type IS
  'Canonical cadence and task type slug (one_off, recurring, habit, milestone; default one_off; ADR-117).';
COMMENT ON COLUMN public.user_tasks.recurrence_rule IS
  'Optional schedule or RRULE string when task_type is recurring or habit (ADR-117).';
COMMENT ON COLUMN public.user_tasks.effort IS
  'Optional execution effort size slug (quick, small, medium, large; ADR-117).';
COMMENT ON COLUMN public.user_tasks.energy_mode IS
  'Optional cognitive or execution mode slug (deep_work, admin, waiting_on, quick_win; ADR-117).';
COMMENT ON COLUMN public.user_tasks.source IS
  'Optional provenance slug recording how the task entered ahOS (owner, agent_proposed, email_triage, meeting_sweep, ritual; ADR-117).';

CREATE INDEX IF NOT EXISTS idx_user_tasks_task_type
  ON public.user_tasks (task_type);

CREATE INDEX IF NOT EXISTS idx_user_tasks_source
  ON public.user_tasks (source)
  WHERE source IS NOT NULL;

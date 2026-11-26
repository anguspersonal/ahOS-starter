-- Migration: Extend get_blocking_decisions to return full row for artifact detail UI
-- So the "Needs your input" section can show Blocking badge and confidence without extra queries.
-- artifact_id in system_decisions is UUID (migration 017).
-- Must DROP first: PostgreSQL does not allow changing return type with CREATE OR REPLACE.

DROP FUNCTION IF EXISTS public.get_blocking_decisions(text);

CREATE FUNCTION public.get_blocking_decisions(p_artifact_id text)
RETURNS TABLE(
  id uuid,
  decision_type text,
  stage text,
  title text,
  description text,
  confidence_score numeric,
  blocking boolean,
  user_visible boolean,
  requires_user_action boolean,
  review_type text,
  status text,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_notes text,
  snoozed_until timestamptz,
  snooze_count integer,
  artifact_id uuid,
  workflow_task_id bigint,
  target_entity_type text,
  target_entity_id text,
  decision_payload jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  user_id uuid,
  team_id uuid
)
LANGUAGE sql
STABLE
AS $function$
  SELECT
    sd.id,
    sd.decision_type,
    sd.stage,
    sd.title,
    sd.description,
    sd.confidence_score,
    sd.blocking,
    sd.user_visible,
    sd.requires_user_action,
    sd.review_type,
    sd.status,
    sd.resolved_at,
    sd.resolved_by,
    sd.resolution_notes,
    sd.snoozed_until,
    sd.snooze_count,
    sd.artifact_id,
    sd.workflow_task_id,
    sd.target_entity_type,
    sd.target_entity_id,
    sd.decision_payload,
    sd.created_at,
    sd.updated_at,
    sd.user_id,
    sd.team_id
  FROM system_decisions sd
  WHERE sd.artifact_id = p_artifact_id::uuid
    AND sd.blocking = TRUE
    AND sd.status = 'pending'
  ORDER BY sd.created_at ASC;
$function$;

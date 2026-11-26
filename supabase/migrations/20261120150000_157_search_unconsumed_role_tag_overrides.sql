-- Migration 157: preserve role:<role> tag overrides in search_unconsumed_artifacts (#2229)
-- Issues:  #2229 (Round 2 follow-up: preserve role:<role> tag overrides in SQL filters)
-- Refs:    ADR-108 §5, §7, ADR-110 §2, migration 155 (search_unconsumed_artifacts)
-- Date:    2026-11-20

SET statement_timeout = '30min';

-- ============================================================================
-- 1. Update search_unconsumed_artifacts RPC with p_role_override_tags
-- ============================================================================

DROP FUNCTION IF EXISTS public.search_unconsumed_artifacts(
  uuid,
  text[],
  text,
  timestamptz,
  timestamptz,
  boolean,
  text[],
  text[],
  boolean,
  text[],
  text[],
  integer,
  boolean,
  text[],
  boolean,
  boolean
);

CREATE FUNCTION public.search_unconsumed_artifacts(
  p_user_id                 uuid,
  p_kinds                   text[],
  p_provider                text        DEFAULT null,
  p_effective_after         timestamptz DEFAULT null,
  p_effective_before        timestamptz DEFAULT null,
  p_include_discovered      boolean     DEFAULT false,
  p_role_hit_keys           text[]      DEFAULT null,
  p_role_all_keys           text[]      DEFAULT null,
  p_role_default_hit        boolean     DEFAULT false,
  p_exclude_title_patterns  text[]      DEFAULT '{}',
  p_tags                    text[]      DEFAULT null,
  p_limit                   integer     DEFAULT null,
  p_include_archived        boolean     DEFAULT false,
  p_excluded_subtypes       text[]      DEFAULT array['task_request','event_request','daily_log','scaffold']::text[],
  p_with_count              boolean     DEFAULT true,
  p_exclude_robot_authored  boolean     DEFAULT true,
  p_role_override_tags      text[]      DEFAULT null
)
RETURNS TABLE (
  id              uuid,
  title           text,
  plain_text      text,
  created_at      timestamptz,
  captured_at     timestamptz,
  effective_at    timestamptz,
  lifecycle_stage text,
  tags            text[],
  content_subtype text,
  surface         text,
  source_channel  text,
  total_count     bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
SET plan_cache_mode = force_custom_plan
AS $$
BEGIN
  IF p_with_count THEN
    RETURN QUERY
    SELECT
      a.id,
      a.title,
      a.plain_text,
      a.created_at,
      a.captured_at,
      a.effective_at,
      a.lifecycle_stage,
      a.tags,
      a.content_subtype,
      a.surface,
      a.source_channel,
      count(*) OVER () AS total_count
    FROM public.artifacts a
    WHERE a.user_id = p_user_id
      AND (p_include_archived OR a.archived = false)
      AND (p_effective_after IS NULL OR a.effective_at >= p_effective_after)
      AND (p_effective_before IS NULL OR a.effective_at <= p_effective_before)
      AND (a.content_subtype IS NULL OR NOT (a.content_subtype = ANY(p_excluded_subtypes)))
      AND (p_tags IS NULL OR a.tags @> p_tags)
      AND (p_include_discovered OR a.lifecycle_stage IS NULL OR a.lifecycle_stage IN (
        'uploaded',
        'upload_failed',
        'processing',
        'analysed',
        'analysis_failed',
        'needs_review',
        'entities_extracted',
        'actions_extracted',
        'artifacts_created',
        'complete',
        'blocked',
        'archived',
        'extracted',
        'contextualized',
        'actionable',
        'refined',
        'processed'
      ))
      AND NOT EXISTS (
        SELECT 1
        FROM public.artifact_external_links l
        WHERE l.user_id = a.user_id
          AND l.artifact_id = a.id
          AND l.kind = ANY(p_kinds)
          AND (p_provider IS NULL OR l.provider = p_provider)
      )
      AND (
        p_role_hit_keys IS NULL
        OR (p_role_override_tags IS NOT NULL AND coalesce(a.tags, '{}') && p_role_override_tags)
        OR a.surface = ANY(p_role_hit_keys)
        OR ((a.surface IS NULL OR a.surface <> ALL(p_role_all_keys)) AND a.source_channel = ANY(p_role_hit_keys))
        OR (p_role_default_hit AND (a.surface IS NULL OR a.surface <> ALL(p_role_all_keys)) AND (a.source_channel IS NULL OR a.source_channel <> ALL(p_role_all_keys)))
      )
      AND (
        coalesce(cardinality(p_exclude_title_patterns), 0) = 0
        OR coalesce(a.title, '') NOT ILIKE ALL(p_exclude_title_patterns)
      )
      AND (
        NOT p_exclude_robot_authored
        OR NOT (coalesce(a.tags, '{}') && ARRAY['robot_authored', 'auto-task']::text[])
        OR 'not_robot_authored' = ANY(coalesce(a.tags, '{}'))
      )
    ORDER BY a.effective_at DESC, a.id DESC
    LIMIT p_limit;
  ELSE
    RETURN QUERY
    SELECT
      a.id,
      a.title,
      a.plain_text,
      a.created_at,
      a.captured_at,
      a.effective_at,
      a.lifecycle_stage,
      a.tags,
      a.content_subtype,
      a.surface,
      a.source_channel,
      null::bigint AS total_count
    FROM public.artifacts a
    WHERE a.user_id = p_user_id
      AND (p_include_archived OR a.archived = false)
      AND (p_effective_after IS NULL OR a.effective_at >= p_effective_after)
      AND (p_effective_before IS NULL OR a.effective_at <= p_effective_before)
      AND (a.content_subtype IS NULL OR NOT (a.content_subtype = ANY(p_excluded_subtypes)))
      AND (p_tags IS NULL OR a.tags @> p_tags)
      AND (p_include_discovered OR a.lifecycle_stage IS NULL OR a.lifecycle_stage IN (
        'uploaded',
        'upload_failed',
        'processing',
        'analysed',
        'analysis_failed',
        'needs_review',
        'entities_extracted',
        'actions_extracted',
        'artifacts_created',
        'complete',
        'blocked',
        'archived',
        'extracted',
        'contextualized',
        'actionable',
        'refined',
        'processed'
      ))
      AND NOT EXISTS (
        SELECT 1
        FROM public.artifact_external_links l
        WHERE l.user_id = a.user_id
          AND l.artifact_id = a.id
          AND l.kind = ANY(p_kinds)
          AND (p_provider IS NULL OR l.provider = p_provider)
      )
      AND (
        p_role_hit_keys IS NULL
        OR (p_role_override_tags IS NOT NULL AND coalesce(a.tags, '{}') && p_role_override_tags)
        OR a.surface = ANY(p_role_hit_keys)
        OR ((a.surface IS NULL OR a.surface <> ALL(p_role_all_keys)) AND a.source_channel = ANY(p_role_hit_keys))
        OR (p_role_default_hit AND (a.surface IS NULL OR a.surface <> ALL(p_role_all_keys)) AND (a.source_channel IS NULL OR a.source_channel <> ALL(p_role_all_keys)))
      )
      AND (
        coalesce(cardinality(p_exclude_title_patterns), 0) = 0
        OR coalesce(a.title, '') NOT ILIKE ALL(p_exclude_title_patterns)
      )
      AND (
        NOT p_exclude_robot_authored
        OR NOT (coalesce(a.tags, '{}') && ARRAY['robot_authored', 'auto-task']::text[])
        OR 'not_robot_authored' = ANY(coalesce(a.tags, '{}'))
      )
    ORDER BY a.effective_at DESC, a.id DESC
    LIMIT p_limit;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.search_unconsumed_artifacts(uuid, text[], text, timestamptz, timestamptz, boolean, text[], text[], boolean, text[], text[], integer, boolean, text[], boolean, boolean, text[]) IS
  'Evaluates unconsumed artifacts anti-join, role-ranked filters with role:<role> tag overrides, and pre-LIMIT robot-row exclusion in the database (#1769, #2229, migration 157). Returns page rows and exact total_count in one statement.';

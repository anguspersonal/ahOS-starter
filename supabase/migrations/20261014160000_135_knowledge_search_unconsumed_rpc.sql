-- Migration 135: unconsumed artifacts anti-join RPC and enriched subset index
-- Issues:  #1769 (mcp-server: evaluate not_consumed in the database and index the enriched subset)
-- Refs:    ADR-108 §7 (read-path precondition for scheduled ingestion),
--          ADR-046 §1 (no second store), ADR-050 §8 / ADR-052 §1 (metrics are queries over the ledger),
--          ADR-067 Amendment 1 (ranking in SQL, 1000-row PostgREST cap),
--          migration 047 (artifact_external_links), migration 118 (index comments & timeouts)
-- Date:    2026-10-14

SET statement_timeout = '30min';

-- ============================================================================
-- 1. idx_artifacts_user_enriched_effective (#1769)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_artifacts_user_enriched_effective
  ON public.artifacts (user_id, effective_at DESC)
  INCLUDE (id, lifecycle_stage, content_subtype, surface, source_channel)
  WHERE archived = false AND (lifecycle_stage IS NULL OR lifecycle_stage IN (
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
  ));

COMMENT ON INDEX public.idx_artifacts_user_enriched_effective IS
  'Partial index over active enriched artifacts for unconsumed synthesis reads (#1769, migration 135).';

-- ============================================================================
-- 2. search_unconsumed_artifacts RPC (#1769)
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
  p_with_count              boolean     DEFAULT true
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
        OR a.surface = ANY(p_role_hit_keys)
        OR ((a.surface IS NULL OR a.surface <> ALL(p_role_all_keys)) AND a.source_channel = ANY(p_role_hit_keys))
        OR (p_role_default_hit AND (a.surface IS NULL OR a.surface <> ALL(p_role_all_keys)) AND (a.source_channel IS NULL OR a.source_channel <> ALL(p_role_all_keys)))
      )
      AND (
        coalesce(cardinality(p_exclude_title_patterns), 0) = 0
        OR coalesce(a.title, '') NOT ILIKE ALL(p_exclude_title_patterns)
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
        OR a.surface = ANY(p_role_hit_keys)
        OR ((a.surface IS NULL OR a.surface <> ALL(p_role_all_keys)) AND a.source_channel = ANY(p_role_hit_keys))
        OR (p_role_default_hit AND (a.surface IS NULL OR a.surface <> ALL(p_role_all_keys)) AND (a.source_channel IS NULL OR a.source_channel <> ALL(p_role_all_keys)))
      )
      AND (
        coalesce(cardinality(p_exclude_title_patterns), 0) = 0
        OR coalesce(a.title, '') NOT ILIKE ALL(p_exclude_title_patterns)
      )
    ORDER BY a.effective_at DESC, a.id DESC
    LIMIT p_limit;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.search_unconsumed_artifacts(uuid, text[], text, timestamptz, timestamptz, boolean, text[], text[], boolean, text[], text[], integer, boolean, text[], boolean) IS
  'Evaluates unconsumed artifacts anti-join and role-ranked filters in the database (#1769, migration 135). Returns page rows and exact total_count in one statement.';

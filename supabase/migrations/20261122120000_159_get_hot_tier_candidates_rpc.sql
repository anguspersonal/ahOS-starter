-- Migration 159: public.get_hot_tier_candidates RPC for hot_tier_candidates (#2392, #1154)
-- Issue: #2392 (slice of #1154 — grill outcome, 21 Nov 2026, decisions 1, 3, and 4)
-- Date:  2026-11-22
--
-- RULES (#1154):
-- 1. A mention is one distinct artifact linked to the entity by any artifact_entity_links
--    row, where the artifact belongs to the user, is not archived, has content_subtype other
--    than 'daily_log' and 'scaffold', and has COALESCE(effective_at, captured_at) >= p_window_start.
-- 2. The artifact is the owner's own: neither surface nor source_channel is in p_excluded_surfaces,
--    and it is not robot-authored (tags contains 'robot_authored' or 'auto-task' excludes it
--    unless 'not_robot_authored' is also present; matches migration 155).
-- 3. The entity belongs to the user, is not archived, is not hot, has entity_type in
--    p_entity_types, and has no properties.hot_declined_at on or after p_quiet_start.
--    Only a value starting with YYYY-MM-DD counts as a decline; anything else is no decline.
-- 4. Keep entities with at least p_min_mentions distinct mentions; order by mentions DESC,
--    last_mention_at DESC, id ASC; return at most p_limit rows.
-- 5. Also return hot_count: the user's count of non-archived hot = true rows in entities.

SET statement_timeout = '15s';

DROP FUNCTION IF EXISTS public.get_hot_tier_candidates(
  uuid, timestamptz, integer, integer, timestamptz, text[], text[]
);

CREATE FUNCTION public.get_hot_tier_candidates(
  p_user_id           uuid,
  p_window_start      timestamptz,
  p_min_mentions      integer DEFAULT 3,
  p_limit             integer DEFAULT 5,
  p_quiet_start       timestamptz DEFAULT (now() - interval '90 days'),
  p_excluded_surfaces text[] DEFAULT '{}'::text[],
  p_entity_types      text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH hot_tier AS (
  SELECT COUNT(*)::integer AS hot_count
  FROM public.entities e
  WHERE e.user_id = p_user_id
    AND COALESCE(e.archived, false) = false
    AND COALESCE(e.hot, false) = true
),
quiet_cutoff AS (
  SELECT to_char(p_quiet_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS cutoff_date
),
ranked AS (
  SELECT
    e.id::text AS id,
    e.entity_type,
    e.title,
    COALESCE(e.aliases, '{}'::text[]) AS aliases,
    COUNT(DISTINCT a.id)::integer AS mentions,
    MAX(COALESCE(a.effective_at, a.captured_at)) AS last_mention_at
  FROM public.entities e
  JOIN public.artifact_entity_links l
    ON l.entity_id = e.id
  JOIN public.artifacts a
    ON a.id = l.artifact_id
  CROSS JOIN quiet_cutoff q
  WHERE e.user_id = p_user_id
    AND COALESCE(e.archived, false) = false
    AND COALESCE(e.hot, false) = false
    AND e.entity_type = ANY(COALESCE(p_entity_types, '{}'::text[]))
    AND NOT (
      COALESCE(e.properties->>'hot_declined_at', '') ~ '^\d{4}-\d{2}-\d{2}'
      AND substring(e.properties->>'hot_declined_at' FROM 1 FOR 10) >= q.cutoff_date
    )
    AND a.user_id = p_user_id
    AND COALESCE(a.archived, false) = false
    AND a.content_subtype IS DISTINCT FROM 'daily_log'
    AND a.content_subtype IS DISTINCT FROM 'scaffold'
    AND COALESCE(a.effective_at, a.captured_at) >= p_window_start
    AND (a.surface IS NULL OR NOT (a.surface = ANY(COALESCE(p_excluded_surfaces, '{}'::text[]))))
    AND (a.source_channel IS NULL OR NOT (a.source_channel = ANY(COALESCE(p_excluded_surfaces, '{}'::text[]))))
    AND (
      NOT (COALESCE(a.tags, '{}'::text[]) && ARRAY['robot_authored', 'auto-task']::text[])
      OR 'not_robot_authored' = ANY(COALESCE(a.tags, '{}'::text[]))
    )
  GROUP BY e.id, e.entity_type, e.title, e.aliases
  HAVING COUNT(DISTINCT a.id) >= GREATEST(COALESCE(p_min_mentions, 1), 1)
  ORDER BY mentions DESC, last_mention_at DESC, e.id ASC
  LIMIT GREATEST(COALESCE(p_limit, 0), 0)
)
SELECT jsonb_build_object(
  'hot_count', (SELECT hot_count FROM hot_tier),
  'candidates', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'entity_type', r.entity_type,
          'title', r.title,
          'aliases', to_jsonb(r.aliases),
          'mentions', r.mentions,
          'last_mention_at', r.last_mention_at
        )
        ORDER BY r.mentions DESC, r.last_mention_at DESC, r.id ASC
      )
      FROM ranked r
    ),
    '[]'::jsonb
  )
);
$$;

REVOKE ALL ON FUNCTION public.get_hot_tier_candidates(
  uuid, timestamptz, integer, integer, timestamptz, text[], text[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hot_tier_candidates(
  uuid, timestamptz, integer, integer, timestamptz, text[], text[]
) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_hot_tier_candidates(uuid, timestamptz, integer, integer, timestamptz, text[], text[]) IS
  'Ranks non-hot entities by distinct owner-authored artifact mentions over a trailing window and returns current non-archived hot_count (#2392, #1154).';

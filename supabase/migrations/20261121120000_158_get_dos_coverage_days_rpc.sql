-- Migration 158: public.get_dos_coverage_days, the per-day dos coverage read in SQL
-- Issue: #2264 (PR 1 of 2; the readers switch to it in #2312, after #2310 pushes this)
-- ADR:   ADR-119 (amends ADR-088 §3)
-- Date:  2026-11-21
--
-- WHAT IT REPLACES (not yet; nothing calls this function at runtime in this migration):
-- getSynthesisCoverage and getStreak (packages/core/src/adapters/supabase/externalLinks.ts)
-- fetch every non-pointer artifact in range, 1,000 a page, to produce one row per day.
-- This function returns the same rows from one statement. The material count is meant to
-- be an index-only aggregate on idx_artifacts_user_material_captured (migration 153); the
-- marker half joins artifacts by id and reads captured_at and effective_at from the heap.
-- Neither plan has been seen on production rows: confirm with EXPLAIN in #2310.
--
-- THE RULES (each must match the TypeScript oracle exactly; the parity script
-- packages/mcp-server/scripts/dos-coverage-parity.ts checks them on production rows):
--
-- 1. Attributed day (coverageDateForArtifact, COVERAGE_MAX_EFFECTIVE_LAG_DAYS = 7).
--    Take the UTC dates of captured_at and effective_at. When the effective_at date is
--    0 to 7 calendar days before the captured_at date the day is the effective_at date,
--    otherwise the captured_at date. When one is NULL the other decides; when both are
--    NULL the row has no day and is dropped. The boundary is UTC, not the Europe/London
--    boundary get_dos_evidence_aggregate (migration 156) uses.
--
-- 2. Material (isSynthesizableMaterial). Not a discovered or failed pointer, and not a
--    daily_log twin or a scaffold. The stage half is written exactly as the predicate of
--    idx_artifacts_user_material_captured (migration 153) so the planner can prove the
--    partial index applies; the predicate is a constant, so it holds for a generic plan.
--    Archived rows are counted: soft-deleting an atom must not reopen a closed day.
--
-- 3. Markers. The four closing kinds, joined to their artifact with no stage or material
--    filter (a marker on a pointer or a twin still counts). Counts are per marker row.
--    Id arrays are distinct non-empty external_ids in byte order (COLLATE "C"), which is
--    the order JavaScript's default sort gives. A marker's day is its artifact's
--    attributed day, never the marker row's created_at. p_provider scopes marker rows
--    only; material counts are domain-blind. NULL means every provider.
--
-- 4. Window edge (the one intended difference from today's TypeScript read). Attribution
--    can move a row up to 7 days before its captured_at, so material is scanned over
--    captured_at in [p_from, p_to + 7 days], bucketed by attributed day, and only days in
--    [p_from, p_to] are kept. Today's read stops the scan at p_to and misses an atom
--    captured the day after and dated inside the window.
--
-- 5. p_from NULL means the earliest attributed day of any closing marker in scope (the
--    streak's start). With no marker the result is '[]'.
--
-- captured_atoms is exact; there is no per-day cap (COVERAGE_MAX_ATOMS_PER_DAY is a
-- paging device of the TypeScript read, removed with it in #2312).
--
-- RETURNS jsonb: an array, one object per day from the start day to p_to, ascending, with
-- the fields of SynthesisCoverageDay (packages/core/src/ports/externalLinks.ts). jsonb
-- and not SETOF so PostgREST's 1,000-row cap cannot truncate a long streak history.

SET statement_timeout = '15s';

DROP FUNCTION IF EXISTS public.get_dos_coverage_days(uuid, date, date, text);

CREATE FUNCTION public.get_dos_coverage_days(
    p_user_id uuid,
    p_from date,
    p_to date,
    p_provider text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH marker_rows AS (
    SELECT
        ael.kind,
        ael.external_id,
        CASE
            WHEN d.captured_day IS NULL THEN d.effective_day
            WHEN d.effective_day IS NULL THEN d.captured_day
            WHEN d.captured_day - d.effective_day BETWEEN 0 AND 7 THEN d.effective_day
            ELSE d.captured_day
        END AS day
    FROM public.artifact_external_links ael
    JOIN public.artifacts a
      ON a.id = ael.artifact_id
     AND a.user_id = ael.user_id
    CROSS JOIN LATERAL (
        SELECT
            (a.captured_at AT TIME ZONE 'UTC')::date AS captured_day,
            (a.effective_at AT TIME ZONE 'UTC')::date AS effective_day
    ) d
    WHERE ael.user_id = p_user_id
      AND ael.kind IN (
          'synthesized',
          'synthesized_unattended',
          'evidence_aggregated',
          'evidence_aggregated_unattended'
      )
      AND (p_provider IS NULL OR ael.provider = p_provider)
),
bounds AS (
    SELECT
        COALESCE(p_from, (SELECT min(m.day) FROM marker_rows m)) AS from_day,
        p_to AS to_day
),
material_rows AS (
    SELECT
        CASE
            WHEN d.captured_day IS NULL THEN d.effective_day
            WHEN d.effective_day IS NULL THEN d.captured_day
            WHEN d.captured_day - d.effective_day BETWEEN 0 AND 7 THEN d.effective_day
            ELSE d.captured_day
        END AS day
    FROM public.artifacts
    CROSS JOIN LATERAL (
        SELECT
            (captured_at AT TIME ZONE 'UTC')::date AS captured_day,
            (effective_at AT TIME ZONE 'UTC')::date AS effective_day
    ) d
    WHERE user_id = p_user_id
      AND captured_at >= ((SELECT b.from_day FROM bounds b)::timestamp AT TIME ZONE 'UTC')
      AND captured_at < (((SELECT b.to_day FROM bounds b) + 8)::timestamp AT TIME ZONE 'UTC')
      AND (lifecycle_stage IS NULL OR lifecycle_stage <> ALL (ARRAY['discovered'::text, 'failed'::text]))
      AND content_subtype IS DISTINCT FROM 'daily_log'
      AND content_subtype IS DISTINCT FROM 'scaffold'
),
material_days AS (
    SELECT mr.day, count(*)::int AS captured_atoms
    FROM material_rows mr
    GROUP BY mr.day
),
marker_kinds AS (
    SELECT
        g.day,
        g.kind,
        sum(g.n)::int AS n,
        COALESCE(
            jsonb_agg(g.external_id ORDER BY g.external_id COLLATE "C")
                FILTER (WHERE g.external_id IS NOT NULL AND g.external_id <> ''),
            '[]'::jsonb
        ) AS ids
    FROM (
        SELECT m.day, m.kind, m.external_id, count(*) AS n
        FROM marker_rows m
        WHERE m.day IS NOT NULL
        GROUP BY m.day, m.kind, m.external_id
    ) g
    GROUP BY g.day, g.kind
),
marker_days AS (
    SELECT
        mk.day,
        jsonb_object_agg(mk.kind, mk.n) AS counts,
        jsonb_object_agg(mk.kind, mk.ids) AS ids
    FROM marker_kinds mk
    GROUP BY mk.day
),
days AS (
    SELECT
        s.day,
        COALESCE((md.counts ->> 'synthesized')::int, 0) AS synthesized,
        COALESCE((md.counts ->> 'synthesized_unattended')::int, 0) AS synthesized_unattended,
        COALESCE((md.counts ->> 'evidence_aggregated')::int, 0) AS evidence_aggregated,
        COALESCE((md.counts ->> 'evidence_aggregated_unattended')::int, 0) AS evidence_aggregated_unattended,
        COALESCE(md.ids -> 'synthesized', '[]'::jsonb) AS synthesized_external_ids,
        COALESCE(md.ids -> 'synthesized_unattended', '[]'::jsonb) AS synthesized_unattended_external_ids,
        COALESCE(md.ids -> 'evidence_aggregated', '[]'::jsonb) AS evidence_aggregated_external_ids,
        COALESCE(md.ids -> 'evidence_aggregated_unattended', '[]'::jsonb) AS evidence_aggregated_unattended_external_ids,
        COALESCE(mat.captured_atoms, 0) AS captured_atoms
    FROM bounds b
    CROSS JOIN LATERAL (
        SELECT b.from_day + offs AS day
        FROM generate_series(0, b.to_day - b.from_day) AS offs
    ) s
    LEFT JOIN marker_days md ON md.day = s.day
    LEFT JOIN material_days mat ON mat.day = s.day
)
SELECT COALESCE(
    jsonb_agg(
        jsonb_build_object(
            'date', to_char(dy.day, 'YYYY-MM-DD'),
            'synthesized', dy.synthesized,
            'synthesized_unattended', dy.synthesized_unattended,
            'synthesized_external_ids', dy.synthesized_external_ids,
            'synthesized_unattended_external_ids', dy.synthesized_unattended_external_ids,
            'evidence_aggregated', dy.evidence_aggregated,
            'evidence_aggregated_unattended', dy.evidence_aggregated_unattended,
            'evidence_aggregated_external_ids', dy.evidence_aggregated_external_ids,
            'evidence_aggregated_unattended_external_ids', dy.evidence_aggregated_unattended_external_ids,
            'captured_atoms', dy.captured_atoms,
            'no_material',
                dy.captured_atoms = 0
                AND dy.synthesized = 0
                AND dy.synthesized_unattended = 0
                AND dy.evidence_aggregated = 0
                AND dy.evidence_aggregated_unattended = 0
        )
        ORDER BY dy.day
    ),
    '[]'::jsonb
)
FROM days dy;
$$;

REVOKE ALL ON FUNCTION public.get_dos_coverage_days(uuid, date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dos_coverage_days(uuid, date, date, text)
    TO authenticated, service_role;

COMMENT ON FUNCTION public.get_dos_coverage_days(uuid, date, date, text) IS
  'Per-UTC-day dos coverage: synthesis-material atom count plus closing-marker counts and page ids per kind, attributed by the ADR-119 rule (effective_at day when 0 to 7 days before the captured_at day, else the captured_at day). p_from NULL starts at the earliest marker day. Must stay in parity with coverageDateForArtifact and isSynthesizableMaterial in externalLinks.ts. Issue #2264, migration 158.';

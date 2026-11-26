-- Migration 156: Add public.get_dos_evidence_aggregate RPC for dos_evidence_aggregate (ADR-108 §5-§6, ADR-109 §3-§7, #2228).

SET statement_timeout = '15s';

DROP FUNCTION IF EXISTS public.get_dos_evidence_aggregate(
    uuid, text, integer, date, date, text, integer, jsonb, text
);

CREATE FUNCTION public.get_dos_evidence_aggregate(
    p_user_id uuid,
    p_domain text,
    p_days integer DEFAULT 14,
    p_since date DEFAULT NULL,
    p_until date DEFAULT NULL,
    p_timezone text DEFAULT 'Europe/London',
    p_top_n integer DEFAULT 5,
    p_surface_role_map jsonb DEFAULT NULL,
    p_default_role text DEFAULT 'narrative'
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH params AS (
    SELECT
        p_user_id AS user_id,
        CASE
            WHEN lower(trim(coalesce(p_domain, ''))) IN ('angus', 'personal') THEN 'personal'
            WHEN lower(trim(coalesce(p_domain, ''))) = 'work' THEN 'work'
            ELSE lower(trim(coalesce(p_domain, '')))
        END AS target_domain,
        CASE
            WHEN lower(trim(coalesce(p_domain, ''))) IN ('angus', 'personal') THEN 'angus'
            ELSE lower(trim(coalesce(p_domain, '')))
        END AS canonical_domain,
        LEAST(GREATEST(COALESCE(p_days, 14), 1), 90) AS days_count,
        COALESCE(NULLIF(trim(p_timezone), ''), 'Europe/London') AS tz,
        LEAST(GREATEST(COALESCE(p_top_n, 5), 0), 50) AS top_n,
        COALESCE(NULLIF(trim(p_default_role), ''), 'narrative') AS default_role,
        COALESCE(
            p_surface_role_map,
            '{
                "act_receipt": "evidence",
                "github": "evidence",
                "slack": "evidence",
                "slack_dm": "evidence",
                "whatsapp": "evidence",
                "whatsapp_dm": "evidence",
                "derived": "evidence",
                "gmail_ingest": "evidence",
                "kpi_snapshot": "metrics"
            }'::jsonb
        ) AS role_map
),
bounds AS (
    SELECT
        p.*,
        COALESCE(p_until, (now() AT TIME ZONE p.tz)::date) AS until_date,
        COALESCE(
            p_since,
            (COALESCE(p_until, (now() AT TIME ZONE p.tz)::date) - (p.days_count - 1))::date
        ) AS since_date
    FROM params p
),
raw_rows AS (
    SELECT
        a.id,
        a.title,
        a.surface,
        a.source_channel,
        a.content_subtype,
        a.lifecycle_stage,
        a.tags,
        a.plain_text,
        a.description,
        a.captured_at,
        COALESCE(a.effective_at, a.captured_at) AS effective_at,
        to_char(a.captured_at AT TIME ZONE b.tz, 'YYYY-MM-DD') AS captured_date,
        to_char(COALESCE(a.effective_at, a.captured_at) AT TIME ZONE b.tz, 'YYYY-MM-DD') AS event_date,
        parent.surface AS parent_surface,
        parent.source_channel AS parent_source_channel,
        parent.tags AS parent_tags,
        b.target_domain,
        b.canonical_domain,
        b.top_n,
        b.default_role,
        b.role_map,
        b.since_date,
        b.until_date,
        b.tz
    FROM bounds b
    JOIN public.artifacts a
      ON a.user_id = b.user_id
     AND a.archived = false
     AND a.content_subtype IS DISTINCT FROM 'daily_log'
     AND a.captured_at >= (b.since_date::timestamp AT TIME ZONE b.tz)
     AND a.captured_at < ((b.until_date + 1)::timestamp AT TIME ZONE b.tz)
    LEFT JOIN public.artifacts parent
      ON parent.id = CASE
            WHEN (a.processing_metadata->>'derived_from') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (a.processing_metadata->>'derived_from')::uuid
            ELSE NULL
         END
     AND parent.user_id = a.user_id
),
classified AS (
    SELECT
        r.*,
        (
            SELECT lower(substring(t FROM 6))
            FROM unnest(coalesce(r.tags, '{}'::text[])) AS t
            WHERE lower(t) IN ('role:narrative', 'role:evidence', 'role:metrics', 'role:excluded')
            LIMIT 1
        ) AS role_override_tag,
        (
            (
                coalesce(r.tags, '{}'::text[]) && ARRAY['robot_authored', 'auto-task']
                OR lower(coalesce(r.title, '')) LIKE '%[auto-task]%'
                OR lower(coalesce(r.title, '')) LIKE '%auto-task%'
                OR lower(coalesce(r.title, '')) LIKE '%scheduled routine%'
                OR coalesce(r.plain_text, '') LIKE '%Scheduled routine completed%'
                OR coalesce(r.description, '') LIKE '%Scheduled routine completed%'
            )
            AND NOT ('not_robot_authored' = ANY(coalesce(r.tags, '{}'::text[])))
        ) AS is_robot_authored,
        CASE
            WHEN COALESCE(r.surface, r.parent_surface) = 'github' THEN
                COALESCE(
                    (SELECT t FROM unnest(coalesce(r.tags, '{}'::text[])) AS t WHERE t LIKE 'repo:%' LIMIT 1),
                    (SELECT t FROM unnest(coalesce(r.parent_tags, '{}'::text[])) AS t WHERE t LIKE 'repo:%' LIMIT 1),
                    'github'
                )
            WHEN COALESCE(r.source_channel, r.parent_source_channel) = 'slack_dm'
              OR COALESCE(r.surface, r.parent_surface) = 'slack_dm' THEN
                'slack:dm'
            WHEN COALESCE(r.surface, r.parent_surface) = 'slack' THEN
                COALESCE(
                    (SELECT t FROM unnest(coalesce(r.tags, '{}'::text[])) AS t WHERE t LIKE 'slack:channel:%' LIMIT 1),
                    (SELECT t FROM unnest(coalesce(r.parent_tags, '{}'::text[])) AS t WHERE t LIKE 'slack:channel:%' LIMIT 1),
                    'slack'
                )
            WHEN r.content_subtype = 'act_receipt'
              OR COALESCE(r.source_channel, r.parent_source_channel) = 'gmail_ingest'
              OR COALESCE(r.surface, r.parent_surface) = 'gmail_ingest' THEN
                COALESCE(
                    (SELECT t FROM unnest(coalesce(r.tags, '{}'::text[])) AS t WHERE t LIKE 'account:%' LIMIT 1),
                    (SELECT t FROM unnest(coalesce(r.parent_tags, '{}'::text[])) AS t WHERE t LIKE 'account:%' LIMIT 1),
                    COALESCE(r.surface, r.parent_surface, 'unknown')
                )
            ELSE
                COALESCE(r.surface, r.parent_surface, 'unknown')
        END AS connection,
        COALESCE(
            -- 1. Explicit domain:<d> tag on row
            (
                SELECT CASE
                    WHEN lower(substring(t FROM 8)) IN ('angus', 'personal') THEN 'personal'
                    WHEN lower(substring(t FROM 8)) = 'work' THEN 'work'
                    ELSE NULL
                END
                FROM unnest(coalesce(r.tags, '{}'::text[])) AS t
                WHERE lower(t) IN ('domain:work', 'domain:angus', 'domain:personal')
                LIMIT 1
            ),
            -- 2. Explicit domain:<d> tag on parent
            (
                SELECT CASE
                    WHEN lower(substring(t FROM 8)) IN ('angus', 'personal') THEN 'personal'
                    WHEN lower(substring(t FROM 8)) = 'work' THEN 'work'
                    ELSE NULL
                END
                FROM unnest(coalesce(r.parent_tags, '{}'::text[])) AS t
                WHERE lower(t) IN ('domain:work', 'domain:angus', 'domain:personal')
                LIMIT 1
            ),
            -- 3. Surface / source_channel on row (or parent if derived)
            CASE
                WHEN (CASE WHEN r.surface = 'derived' THEN r.parent_surface ELSE r.surface END) IN (
                    'slack', 'slack_dm',
                    'discovered_gdrive_work', 'discovered_gmail_attachment_work',
                    'discovered_notion_meetings_work', 'discovered_notion_pages_work'
                ) THEN 'work'
                WHEN (CASE WHEN r.surface = 'derived' THEN r.parent_surface ELSE r.surface END) IN (
                    'discovered_gdrive', 'discovered_google_drive', 'discovered_drive',
                    'discovered_gmail_attachment',
                    'discovered_notion_meetings_personal', 'discovered_notion_pages_personal'
                ) THEN 'personal'
                WHEN (CASE WHEN r.surface = 'derived' THEN r.parent_source_channel ELSE r.source_channel END) IN (
                    'slack', 'slack_dm',
                    'discovered_gdrive_work', 'discovered_gmail_attachment_work',
                    'discovered_notion_meetings_work', 'discovered_notion_pages_work'
                ) THEN 'work'
                WHEN (CASE WHEN r.surface = 'derived' THEN r.parent_source_channel ELSE r.source_channel END) IN (
                    'discovered_gdrive', 'discovered_google_drive', 'discovered_drive',
                    'discovered_gmail_attachment',
                    'discovered_notion_meetings_personal', 'discovered_notion_pages_personal'
                ) THEN 'personal'
                ELSE NULL
            END,
            -- 4. repo:* or account:* or slack:* tags on row or parent
            (
                SELECT CASE
                    WHEN lower(t) LIKE 'repo:example-org/%' OR lower(t) = 'repo:example-org' THEN 'work'
                    WHEN lower(t) LIKE 'repo:anguspersonal/%' OR lower(t) = 'repo:anguspersonal' THEN 'personal'
                    WHEN lower(t) LIKE 'slack:channel:%' OR lower(t) = 'slack:dm' THEN 'work'
                    WHEN lower(t) LIKE 'account:%@work.example.com' OR lower(t) IN ('account:work', 'account:notion_work', 'account:google_work') THEN 'work'
                    WHEN lower(t) LIKE 'account:%' THEN 'personal'
                    ELSE NULL
                END
                FROM unnest(coalesce(r.tags, '{}'::text[]) || coalesce(r.parent_tags, '{}'::text[])) AS t
                WHERE lower(t) LIKE 'repo:%'
                   OR lower(t) LIKE 'slack:%'
                   OR lower(t) LIKE 'account:%'
                LIMIT 1
            )
        ) AS resolved_domain
    FROM raw_rows r
),
with_roles AS (
    SELECT
        c.*,
        COALESCE(
            c.role_override_tag,
            CASE WHEN c.is_robot_authored THEN 'excluded' ELSE NULL END,
            CASE WHEN c.surface IS NOT NULL AND (c.role_map ? c.surface) THEN c.role_map ->> c.surface ELSE NULL END,
            CASE WHEN c.source_channel IS NOT NULL AND (c.role_map ? c.source_channel) THEN c.role_map ->> c.source_channel ELSE NULL END,
            c.default_role
        ) AS effective_role
    FROM classified c
    WHERE c.resolved_domain = c.target_domain
),
material_rows AS (
    SELECT
        w.*,
        (
            w.effective_role = 'evidence'
            AND NOT w.is_robot_authored
            AND coalesce(w.lifecycle_stage, '') NOT IN ('discovered', 'failed')
            AND coalesce(w.content_subtype, '') NOT IN ('task_request', 'event_request', 'scaffold')
        ) AS is_structural_evidence
    FROM with_roles w
    WHERE (
        w.effective_role IN ('evidence', 'metrics', 'excluded')
        OR (w.effective_role = 'narrative' AND w.is_robot_authored)
        OR w.lifecycle_stage IN ('discovered', 'failed')
        OR w.content_subtype IN ('task_request', 'event_request', 'scaffold')
    )
),
day_closing_links AS (
    SELECT
        d_str AS day_date,
        MAX(ael.created_at) AS closing_link_created_at
    FROM bounds b
    CROSS JOIN LATERAL (
        SELECT to_char(gs::date, 'YYYY-MM-DD') AS d_str
        FROM generate_series(b.since_date, b.until_date, interval '1 day') AS gs
    ) days_seq
    JOIN public.artifact_external_links ael
      ON ael.user_id = b.user_id
     AND ael.kind IN ('evidence_aggregated', 'evidence_aggregated_unattended')
    JOIN public.artifacts twin
      ON twin.id = ael.artifact_id
     AND twin.user_id = b.user_id
     AND twin.archived = false
     AND twin.content_subtype = 'daily_log'
    WHERE (
        ael.external_id LIKE 'dos:daily-log:' || b.target_domain || ':' || days_seq.d_str || '%'
        OR (b.target_domain = 'personal' AND ael.external_id LIKE 'dos:daily-log:angus:' || days_seq.d_str || '%')
        OR (
            twin.tags @> ARRAY['daily-log', days_seq.d_str]
            AND (
                twin.tags @> ARRAY['domain:' || b.target_domain]
                OR (b.target_domain = 'personal' AND twin.tags @> ARRAY['domain:angus'])
            )
        )
    )
    GROUP BY d_str
),
grouped AS (
    SELECT
        m.captured_date,
        m.surface,
        m.source_channel,
        m.content_subtype,
        m.connection,
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE m.is_structural_evidence)::int AS evidence_count,
        COUNT(*) FILTER (WHERE NOT m.is_structural_evidence)::int AS excluded_or_robot_count,
        COALESCE(
            (
                SELECT jsonb_agg(item_obj)
                FROM (
                    SELECT jsonb_build_object(
                        'id', sub.id,
                        'title', sub.title,
                        'surface', sub.surface,
                        'source_channel', sub.source_channel,
                        'content_subtype', sub.content_subtype,
                        'connection', sub.connection,
                        'captured_at', sub.captured_at,
                        'effective_at', sub.effective_at,
                        'event_date', sub.event_date
                    ) AS item_obj
                    FROM material_rows sub
                    WHERE sub.captured_date = m.captured_date
                      AND sub.surface IS NOT DISTINCT FROM m.surface
                      AND sub.source_channel IS NOT DISTINCT FROM m.source_channel
                      AND sub.content_subtype IS NOT DISTINCT FROM m.content_subtype
                      AND sub.connection IS NOT DISTINCT FROM m.connection
                      AND sub.is_structural_evidence
                    ORDER BY sub.effective_at DESC, sub.id DESC
                    LIMIT (SELECT top_n FROM bounds)
                ) limited
            ),
            '[]'::jsonb
        ) AS top_n_items
    FROM material_rows m
    GROUP BY m.captured_date, m.surface, m.source_channel, m.content_subtype, m.connection
),
day_buckets AS (
    SELECT
        m.captured_date AS day_date,
        COUNT(*)::int AS material_total,
        COUNT(*) FILTER (WHERE m.is_structural_evidence)::int AS evidence_total,
        COUNT(*) FILTER (WHERE NOT m.is_structural_evidence)::int AS excluded_or_robot_total,
        COUNT(*) FILTER (WHERE m.is_structural_evidence AND m.event_date <> m.captured_date)::int AS dated_earlier_count,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', m.id,
                    'title', m.title,
                    'surface', m.surface,
                    'source_channel', m.source_channel,
                    'content_subtype', m.content_subtype,
                    'connection', m.connection,
                    'captured_at', m.captured_at,
                    'effective_at', m.effective_at,
                    'event_date', m.event_date
                )
                ORDER BY m.effective_at DESC, m.id DESC
            ) FILTER (WHERE m.is_structural_evidence AND m.event_date = m.captured_date),
            '[]'::jsonb
        ) AS items,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', m.id,
                    'title', m.title,
                    'surface', m.surface,
                    'source_channel', m.source_channel,
                    'content_subtype', m.content_subtype,
                    'connection', m.connection,
                    'captured_at', m.captured_at,
                    'effective_at', m.effective_at,
                    'event_date', m.event_date
                )
                ORDER BY m.effective_at DESC, m.id DESC
            ) FILTER (WHERE m.is_structural_evidence AND m.event_date <> m.captured_date),
            '[]'::jsonb
        ) AS dated_earlier_items
    FROM material_rows m
    GROUP BY m.captured_date
),
days_json AS (
    SELECT
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'date', db.day_date,
                    'closed_at', dcl.closing_link_created_at,
                    'material_total', db.material_total,
                    'evidence_total', db.evidence_total,
                    'excluded_or_robot_total', db.excluded_or_robot_total,
                    'dated_earlier_count', db.dated_earlier_count,
                    'dated_earlier_note', CASE
                        WHEN db.dated_earlier_count > 0
                        THEN format('%s arrived on %s, dated earlier', db.dated_earlier_count, db.day_date)
                        ELSE NULL
                    END,
                    'groups', COALESCE(
                        (
                            SELECT jsonb_agg(
                                jsonb_build_object(
                                    'surface', g.surface,
                                    'source_channel', g.source_channel,
                                    'content_subtype', g.content_subtype,
                                    'connection', g.connection,
                                    'count', g.total_count,
                                    'evidence_count', g.evidence_count,
                                    'excluded_or_robot_count', g.excluded_or_robot_count,
                                    'top_n', g.top_n_items
                                )
                                ORDER BY g.total_count DESC, g.connection ASC
                            )
                            FROM grouped g
                            WHERE g.captured_date = db.day_date
                        ),
                        '[]'::jsonb
                    ),
                    'items', db.items,
                    'dated_earlier_items', db.dated_earlier_items
                )
                ORDER BY db.day_date DESC
            ),
            '[]'::jsonb
        ) AS arr
    FROM day_buckets db
    LEFT JOIN day_closing_links dcl ON dcl.day_date = db.day_date
),
late_arrivals_json AS (
    SELECT
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', m.id,
                    'title', m.title,
                    'surface', m.surface,
                    'source_channel', m.source_channel,
                    'content_subtype', m.content_subtype,
                    'connection', m.connection,
                    'captured_at', m.captured_at,
                    'effective_at', m.effective_at,
                    'captured_date', m.captured_date,
                    'closed_at', dcl.closing_link_created_at
                )
                ORDER BY m.captured_at DESC, m.id DESC
            ),
            '[]'::jsonb
        ) AS arr
    FROM material_rows m
    JOIN day_closing_links dcl
      ON dcl.day_date = m.captured_date
    WHERE m.is_structural_evidence
      AND dcl.closing_link_created_at IS NOT NULL
      AND m.captured_at > dcl.closing_link_created_at
)
SELECT jsonb_build_object(
    'domain', (SELECT canonical_domain FROM bounds),
    'timezone', (SELECT tz FROM bounds),
    'since', (SELECT since_date::text FROM bounds),
    'until', (SELECT until_date::text FROM bounds),
    'days', (SELECT arr FROM days_json),
    'late_arrivals', (SELECT arr FROM late_arrivals_json)
);
$$;

REVOKE ALL ON FUNCTION public.get_dos_evidence_aggregate(
    uuid, text, integer, date, date, text, integer, jsonb, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dos_evidence_aggregate(
    uuid, text, integer, date, date, text, integer, jsonb, text
) TO authenticated, service_role;

-- Migration 147: Universal 7-point priority scale and cross-surface mapping table
-- Issue: #1986
-- Refs:  ADR-116 (universal 7-point priority scale 1 lowest to 7 highest and cross-surface mappings)
--        ADR-080 (GitHub issue priority labels)
--        ADR-113 §3 (master cross-domain priority scale)

SET statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.priority_levels (
  level               integer     NOT NULL CHECK (level >= 1 AND level <= 7),
  title               text        NOT NULL UNIQUE,
  description         text        NOT NULL,
  is_default_cut_line boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT priority_levels_pkey PRIMARY KEY (level)
);

COMMENT ON TABLE public.priority_levels IS
  'Canonical 7-point ahOS priority scale (1 = Trivial lowest to 7 = Critical highest; 5 = High is the default focus cut-line per ADR-116).';

INSERT INTO public.priority_levels (level, title, description, is_default_cut_line)
VALUES
  (1, 'Trivial',  'Lowest-stakes item with negligible impact or urgency if delayed indefinitely.', false),
  (2, 'Minor',    'Nice-to-have polish, opportunistic cleanup, or low-leverage task scheduled when capacity allows.', false),
  (3, 'Low',      'Useful improvement or follow-up that can slip to the next week without consequence.', false),
  (4, 'Normal',   'Standard planned work with moderate impact and urgency at the symmetric midpoint of the scale.', false),
  (5, 'High',     'Important committed work for the current week; the default focus cut-line (>= 5) in the Priority Inbox and daily rituals.', true),
  (6, 'Urgent',   'Time-sensitive commitment due within 24 to 48 hours or unblocking another person or critical path.', false),
  (7, 'Critical', 'Drop-everything blocker, live production incident, or hard external deadline today with immediate blast radius.', false)
ON CONFLICT (level) DO UPDATE
SET
  title               = EXCLUDED.title,
  description         = EXCLUDED.description,
  is_default_cut_line = EXCLUDED.is_default_cut_line;

CREATE TABLE IF NOT EXISTS public.priority_surface_mappings (
  surface              text        NOT NULL CHECK (surface IN ('notion_personal', 'notion_work', 'work_mcp', 'github_issue', 'gmail_triage')),
  level                integer     NOT NULL REFERENCES public.priority_levels(level) ON DELETE CASCADE,
  external_value       text        NOT NULL,
  is_canonical_reverse boolean     NOT NULL DEFAULT false,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT priority_surface_mappings_pkey PRIMARY KEY (surface, level)
);

COMMENT ON TABLE public.priority_surface_mappings IS
  'Cross-surface priority translation table mapping each connected surface (notion_personal, notion_work, work_mcp, github_issue, gmail_triage) across all 7 canonical priority levels per ADR-116.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_priority_surface_mappings_canonical_reverse
  ON public.priority_surface_mappings (surface, external_value)
  WHERE is_canonical_reverse = true;

INSERT INTO public.priority_surface_mappings (surface, level, external_value, is_canonical_reverse, notes)
VALUES
  -- Personal Notion (3-tier numbered select: 3 Low, 2 Medium, 1 High)
  ('notion_personal', 1, '3 Low',    false, 'Trivial maps to Personal Notion 3 Low'),
  ('notion_personal', 2, '3 Low',    true,  'Canonical reverse target for Personal Notion 3 Low'),
  ('notion_personal', 3, '2 Medium', false, 'Low maps to Personal Notion 2 Medium'),
  ('notion_personal', 4, '2 Medium', true,  'Canonical reverse target for Personal Notion 2 Medium'),
  ('notion_personal', 5, '1 High',   false, 'High maps to Personal Notion 1 High'),
  ('notion_personal', 6, '1 High',   true,  'Canonical reverse target for Personal Notion 1 High'),
  ('notion_personal', 7, '1 High',   false, 'Critical maps to Personal Notion 1 High'),

  -- Work Notion (3-tier select: Low, Medium, High)
  ('notion_work',  1, 'Low',    false, 'Trivial maps to Work Notion Low'),
  ('notion_work',  2, 'Low',    true,  'Canonical reverse target for Work Notion Low'),
  ('notion_work',  3, 'Medium', false, 'Low maps to Work Notion Medium'),
  ('notion_work',  4, 'Medium', true,  'Canonical reverse target for Work Notion Medium'),
  ('notion_work',  5, 'High',   false, 'High maps to Work Notion High'),
  ('notion_work',  6, 'High',   true,  'Canonical reverse target for Work Notion High'),
  ('notion_work',  7, 'High',   false, 'Critical maps to Work Notion High'),

  -- work-mcp (4-tier label vocabulary: priority:1_critical..4_low)
  ('work_mcp',     1, 'priority:4_low',      false, 'Trivial maps to priority:4_low'),
  ('work_mcp',     2, 'priority:4_low',      true,  'Canonical reverse target for priority:4_low'),
  ('work_mcp',     3, 'priority:3_medium',   false, 'Low maps to priority:3_medium'),
  ('work_mcp',     4, 'priority:3_medium',   true,  'Canonical reverse target for priority:3_medium'),
  ('work_mcp',     5, 'priority:2_high',     true,  'Canonical reverse target for priority:2_high'),
  ('work_mcp',     6, 'priority:1_critical', false, 'Urgent maps to priority:1_critical'),
  ('work_mcp',     7, 'priority:1_critical', true,  'Canonical reverse target for priority:1_critical'),

  -- GitHub Issues (ADR-080 3-label family: priority:low, priority:medium, priority:high)
  ('github_issue',    1, 'priority:low',    false, 'Trivial maps to GitHub priority:low'),
  ('github_issue',    2, 'priority:low',    true,  'Canonical reverse target for GitHub priority:low'),
  ('github_issue',    3, 'priority:medium', false, 'Low maps to GitHub priority:medium'),
  ('github_issue',    4, 'priority:medium', true,  'Canonical reverse target for GitHub priority:medium'),
  ('github_issue',    5, 'priority:high',   false, 'High maps to GitHub priority:high'),
  ('github_issue',    6, 'priority:high',   true,  'Canonical reverse target for GitHub priority:high'),
  ('github_issue',    7, 'priority:high',   false, 'Critical maps to GitHub priority:high'),

  -- Gmail priority triage (7-tier numeric string 1..7)
  ('gmail_triage',    1, '1', true, '1:1 mapping for Gmail triage priority 1'),
  ('gmail_triage',    2, '2', true, '1:1 mapping for Gmail triage priority 2'),
  ('gmail_triage',    3, '3', true, '1:1 mapping for Gmail triage priority 3'),
  ('gmail_triage',    4, '4', true, '1:1 mapping for Gmail triage priority 4'),
  ('gmail_triage',    5, '5', true, '1:1 mapping for Gmail triage priority 5'),
  ('gmail_triage',    6, '6', true, '1:1 mapping for Gmail triage priority 6'),
  ('gmail_triage',    7, '7', true, '1:1 mapping for Gmail triage priority 7')
ON CONFLICT (surface, level) DO UPDATE
SET
  external_value       = EXCLUDED.external_value,
  is_canonical_reverse = EXCLUDED.is_canonical_reverse,
  notes                = EXCLUDED.notes;

ALTER TABLE public.priority_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.priority_surface_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view priority_levels" ON public.priority_levels;
CREATE POLICY "Authenticated users can view priority_levels"
  ON public.priority_levels
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can view priority_surface_mappings" ON public.priority_surface_mappings;
CREATE POLICY "Authenticated users can view priority_surface_mappings"
  ON public.priority_surface_mappings
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.priority_levels, public.priority_surface_mappings FROM anon, authenticated;
GRANT SELECT ON TABLE public.priority_levels, public.priority_surface_mappings TO authenticated, service_role;

-- Extend public.user_tasks with fine-grained 1..7 priority_level
ALTER TABLE public.user_tasks
  ADD COLUMN IF NOT EXISTS priority_level integer CHECK (priority_level >= 1 AND priority_level <= 7);

COMMENT ON COLUMN public.user_tasks.priority_level IS
  'Canonical 7-point priority level (1 = Trivial lowest to 7 = Critical highest; ADR-116).';

CREATE INDEX IF NOT EXISTS idx_user_tasks_priority_level
  ON public.user_tasks (priority_level)
  WHERE priority_level IS NOT NULL;

UPDATE public.user_tasks
SET priority_level = CASE priority
  WHEN 'low'    THEN 2
  WHEN 'medium' THEN 4
  WHEN 'high'   THEN 5
  WHEN 'urgent' THEN 6
  ELSE 4
END
WHERE priority_level IS NULL
  AND priority IS NOT NULL;

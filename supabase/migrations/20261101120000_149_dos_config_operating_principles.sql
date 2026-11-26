-- Migration 149: Separate user_preferences.dos_config.tone from operating_principles (#1984)
--
-- Context (ADR-030, ADR-094, #1984):
--   user_preferences.dos_config.tone previously mixed prose and writing-voice rules
--   with standing engineering and operating heuristics (HTML porting geometry and
--   ambiguous-stakes option variants). This migration curates dos_config.tone to
--   pure prose/writing style rules and populates dos_config.operating_principles
--   with the standing operating heuristics, including "Global max over local max"
--   and "Check what already exists before building".
--
-- Idempotent: preserves existing custom rules in both arrays without duplicating
-- entries on re-run.

SET statement_timeout = '30s';

UPDATE public.user_preferences
SET
  dos_config = jsonb_set(
    jsonb_set(
      dos_config,
      '{tone}',
      (
        SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
        FROM (
          SELECT elem, ord
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(dos_config -> 'tone') = 'array'
                AND jsonb_array_length(dos_config -> 'tone') > 0
              THEN dos_config -> 'tone'
              ELSE $$[
                "Direct, terse, lowercase if matching user register (Slack-style for short confirmations)",
                "Plain British English, no jargon",
                "NEVER use the em-dash. Use commas, semicolons, parentheses, or sentence breaks instead.",
                "No corporate fluff",
                "Push back when warranted; do not soften useful challenge",
                "When confirming actions, brief: Done. [URL]"
              ]$$::jsonb
            END
          ) WITH ORDINALITY AS t(elem, ord)
          WHERE elem #>> '{}' NOT IN (
            'When porting HTML into an app, preserve layout and geometry, drop external stylesheets, and use the app''s own design system tokens.',
            'Offer 2-3 labelled variants when stakes or audience are ambiguous, not a single best guess.'
          )
        ) curated_tone
      ),
      true
    ),
    '{operating_principles}',
    (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM (
        SELECT elem, MIN(ord) AS ord
        FROM (
          SELECT elem, ord
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(dos_config -> 'operating_principles') = 'array'
              THEN dos_config -> 'operating_principles'
              ELSE '[]'::jsonb
            END
          ) WITH ORDINALITY AS existing_op(elem, ord)
          UNION ALL
          SELECT elem, 1000 + ord
          FROM jsonb_array_elements(
            $$[
              "Global max over local max: optimise for the whole system and long-term architecture over a local shortcut or single-surface fix.",
              "Check what already exists before building: inspect existing tables, actions, skills, and capabilities in the repo and kms-db before introducing anything new.",
              "Offer 2-3 labelled variants when stakes or audience are ambiguous, not a single best guess.",
              "When porting HTML into an app, preserve layout and geometry, drop external stylesheets, and use the app's own design system tokens."
            ]$$::jsonb
          ) WITH ORDINALITY AS canonical_op(elem, ord)
        ) combined_op
        GROUP BY elem
      ) deduped_op
    ),
    true
  ),
  updated_at = NOW()
WHERE dos_config IS NOT NULL
  AND jsonb_typeof(dos_config) = 'object';

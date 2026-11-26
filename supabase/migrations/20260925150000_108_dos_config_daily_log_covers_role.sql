-- Migration 108: declare the Daily Log `Covers` property, by role, in dos_config (#1016)
--
-- WHY
-- A Daily Log entry's `Date` is the day it was WRITTEN. Coverage is a projection over
-- the synthesis markers on atoms, bucketed on `captured_at` (ADR-050 section 8, ADR-088
-- section 3). A catch-up run consumes atoms captured on earlier days, so on 2026-09-07
-- an entry dated 5 Sep carried markers on 28 Aug and 4 Sep, and the duplicate guard
-- (#673), keyed on `Date`, then refused the sweep's 5 Sep entry for good.
--
-- Decision (#1016 grill, 2026-09-25, ADR-051 Amendment 4): the entry DECLARES the days
-- it covers in a `Covers` property; daily_log_create writes it and keys its duplicate
-- guard on it; an EMPTY Covers means the entry's own Date. No backfill.
--
-- WHAT THIS DOES
-- Appends one entry to `daily_log_schema.properties` in the work and angus blocks:
--
--   { name: "Covers", notion_type: "rich_text", required: false, role: "covers" }
--
-- `role: "covers"` is the declared join (#703's mechanism): daily_log_create finds the
-- property by role, never by name, and the NAME still lives only in config (migration
-- 087's rule). rich_text, not a date: a Notion date holds one range, not a list of
-- non-adjacent days, and a second date property would make the writer's `Date`
-- discovery ambiguous. The writer also accepts a multi_select of that name.
--
-- ORDERING
-- Either side of the Notion change. The property must ALSO be added by hand to both
-- Notion Daily Log databases (Covers, type Text). Until it is, daily_log_create writes
-- no Covers and guards on Date, with a note in its reply; it never fails the write.
--
-- Idempotent: a block that already declares a property with role "covers" is skipped.
-- Pure DML over a JSONB blob; no DDL.

update user_preferences
set dos_config = jsonb_set(
  dos_config,
  '{by_domain,work,daily_log_schema,properties}',
  coalesce(dos_config #> '{by_domain,work,daily_log_schema,properties}', '[]'::jsonb) || '[
    {
      "name": "Covers",
      "notion_type": "rich_text",
      "required": false,
      "role": "covers",
      "notes": "The days this entry accounts for: comma-separated YYYY-MM-DD, the distinct captured_at dates of the atoms it stamped. Written by daily_log_create from its covers argument, never by hand in properties. Empty means the entry covers its own Date (#1016)."
    }
  ]'::jsonb,
  true
)
where jsonb_typeof(dos_config #> '{by_domain,work,daily_log_schema}') = 'object'
  and coalesce(jsonb_typeof(dos_config #> '{by_domain,work,daily_log_schema,properties}'), 'array') = 'array'
  and not coalesce(
    dos_config #> '{by_domain,work,daily_log_schema,properties}' @> '[{"role": "covers"}]'::jsonb,
    false
  );

update user_preferences
set dos_config = jsonb_set(
  dos_config,
  '{by_domain,angus,daily_log_schema,properties}',
  coalesce(dos_config #> '{by_domain,angus,daily_log_schema,properties}', '[]'::jsonb) || '[
    {
      "name": "Covers",
      "notion_type": "rich_text",
      "required": false,
      "role": "covers",
      "notes": "The days this entry accounts for: comma-separated YYYY-MM-DD, the distinct captured_at dates of the atoms it stamped. Written by daily_log_create from its covers argument, never by hand in properties. Empty means the entry covers its own Date (#1016)."
    }
  ]'::jsonb,
  true
)
where jsonb_typeof(dos_config #> '{by_domain,angus,daily_log_schema}') = 'object'
  and coalesce(jsonb_typeof(dos_config #> '{by_domain,angus,daily_log_schema,properties}'), 'array') = 'array'
  and not coalesce(
    dos_config #> '{by_domain,angus,daily_log_schema,properties}' @> '[{"role": "covers"}]'::jsonb,
    false
  );

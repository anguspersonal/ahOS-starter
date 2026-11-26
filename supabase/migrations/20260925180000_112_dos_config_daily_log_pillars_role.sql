-- Migration 112: declare the Daily Log `Pillars` property, by role, in dos_config (#703)
--
-- WHY
-- Migration 089 declared `Pillars` (type multi_select) in `daily_log_schema.properties`
-- for each domain and changed `pillars[].notion_property` to `pillars[].notion_option`.
-- However, nothing structural linked `pillars[].notion_option` to the `Pillars` property:
-- the join was only described in prose in property notes and skill instructions.
--
-- Decision (#703 grill, 2026-09-25): Option 1, a structural pointer expressed as a role.
-- Add `role: "pillars"` to the pillars property entry in `daily_log_schema.properties`
-- for each domain. Resolution uses the existing findRole / explicit-role helpers in
-- notionPropertyRoles.ts, so the join is code reading config, never an LLM reading notes.
-- Migration 087's rule holds: the property name still lives in config.
--
-- WHAT THIS DOES
-- Updates the `Pillars` property in `daily_log_schema.properties` for both `work`
-- and `angus` domains to carry `role: "pillars"`.
--
-- Idempotent: skips if any property in daily_log_schema.properties already carries role "pillars".
-- Pure DML over a JSONB blob; no DDL.

update user_preferences
set dos_config = jsonb_set(
  dos_config,
  '{by_domain,work,daily_log_schema,properties}',
  (
    select jsonb_agg(
      case
        when p ->> 'name' = 'Pillars' then p || '{"role": "pillars"}'::jsonb
        else p
      end
      order by ord
    )
    from jsonb_array_elements(
      dos_config #> '{by_domain,work,daily_log_schema,properties}'
    ) with ordinality as t(p, ord)
  ),
  false
)
where jsonb_typeof(dos_config #> '{by_domain,work,daily_log_schema,properties}') = 'array'
  and not coalesce(
    dos_config #> '{by_domain,work,daily_log_schema,properties}' @> '[{"role": "pillars"}]'::jsonb,
    false
  );

update user_preferences
set dos_config = jsonb_set(
  dos_config,
  '{by_domain,angus,daily_log_schema,properties}',
  (
    select jsonb_agg(
      case
        when p ->> 'name' = 'Pillars' then p || '{"role": "pillars"}'::jsonb
        else p
      end
      order by ord
    )
    from jsonb_array_elements(
      dos_config #> '{by_domain,angus,daily_log_schema,properties}'
    ) with ordinality as t(p, ord)
  ),
  false
)
where jsonb_typeof(dos_config #> '{by_domain,angus,daily_log_schema,properties}') = 'array'
  and not coalesce(
    dos_config #> '{by_domain,angus,daily_log_schema,properties}' @> '[{"role": "pillars"}]'::jsonb,
    false
  );

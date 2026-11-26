-- Migration 116: declare waiting_on_status per domain in dos_config (#1028)
--
-- WHY
-- ahOS tasks are open or done. That collapses the single most useful distinction in a
-- task list: is the next move mine, or someone else's? An open task blocked on a reply
-- from a supplier is not work, it is a thing to chase, and it needs a different question
-- asked of it ("has this gone quiet?") from a genuine to-do ("when am I doing this?").
--
-- Decision (#1028 grill, 2026-09-25):
-- "Waiting On" becomes a status option on both Tasks databases plus a dos_config key
-- naming it; dos-reflect lists waiting items with "since <date>" and asks "has this gone quiet?".
-- Both target Notion tasks databases already carry these options in production (verified
-- 2026-09-25 via get_notion_tasks_schema: notion_personal has "Awaiting", notion_work
-- has "Awaiting/Review").
--
-- WHAT THIS DOES
-- Sets `by_domain.work.waiting_on_status = 'Awaiting/Review'`
-- and `by_domain.angus.waiting_on_status = 'Awaiting'`
-- in user_preferences.dos_config.
--
-- Pure DML over a JSONB blob; no DDL.

update user_preferences
set dos_config = jsonb_set(
  dos_config,
  '{by_domain,work,waiting_on_status}',
  '"Awaiting/Review"'::jsonb,
  true
)
where jsonb_typeof(dos_config #> '{by_domain,work}') = 'object';

update user_preferences
set dos_config = jsonb_set(
  dos_config,
  '{by_domain,angus,waiting_on_status}',
  '"Awaiting"'::jsonb,
  true
)
where jsonb_typeof(dos_config #> '{by_domain,angus}') = 'object';

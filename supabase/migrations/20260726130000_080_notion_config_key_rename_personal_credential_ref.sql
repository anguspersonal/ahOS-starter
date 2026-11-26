-- 080: align the seeded Notion wiring with the current code (issue #424 defects 2 + 1).
-- (Renumbered from 079 during QA round 1 to avoid colliding with dev's
--  20260726120000_079_add_arrangement_entity_type.sql, issue #327; content unchanged.)
-- Date: 2026-07-25
-- Purpose:
--   Two data corrections in user_integrations. Both are non-destructive (rename a
--   jsonb key preserving its value; repoint a pointer) and idempotent.
--
--   (A) Rename the notion_work config keys *_overflow_* -> *_source_*.
--       Migration 049 seeded the 'notion' row with `tasks_overflow_data_source_id`
--       and `meetings_overflow_data_source_id` because that is what notionConfigSchema
--       expected AT THE TIME. #88 (ADR-022 — the State Doc is a projection, not an
--       overflow sink) renamed the schema keys to `tasks_source_data_source_id` /
--       `meetings_source_data_source_id`, but the SEEDED DATA was never migrated. Since
--       Zod strips unknown keys, the seeded values are silently dropped and
--       get_notion_config reads `undefined` (issue #424 defect 2). Rename the keys in
--       place — the underlying data-source ids are unchanged, only the key name.
--
--   (B) Fix the notion_personal credential_ref pointer.
--       Migration 060 backfilled BOTH notion_work and notion_personal to
--       credential_ref = 'NOTION_API_KEY'. The personal workspace authenticates with a
--       DIFFERENT token — NOTION_PERSONAL_ACCESS_TOKEN (env.notionPersonalToken). With
--       #424 defect 1 fixed in code (notionTokenFor selects the personal token for
--       workspace='notion_personal'), the routing registry should name the correct env
--       var too. credential_ref is a POINTER, never the secret (ADR-032 / migration 060).
--
--   Local verification: `supabase db reset` then re-run the mcp-server unit suite
--   (getNotionConfig / createTask tests). No schema/DDL change, so no type regen needed.

-- (A) notion_work: *_overflow_* -> *_source_* (value preserved; only when present).
UPDATE public.user_integrations
SET config =
      (config - 'tasks_overflow_data_source_id' - 'meetings_overflow_data_source_id')
      || jsonb_strip_nulls(
           jsonb_build_object(
             'tasks_source_data_source_id',    config -> 'tasks_overflow_data_source_id',
             'meetings_source_data_source_id', config -> 'meetings_overflow_data_source_id'
           )
         )
WHERE provider = 'notion_work'
  AND (config ? 'tasks_overflow_data_source_id'
       OR config ? 'meetings_overflow_data_source_id');

-- (B) notion_personal: point credential_ref at the personal token's env var.
UPDATE public.user_integrations
SET credential_ref = 'NOTION_PERSONAL_ACCESS_TOKEN'
WHERE provider = 'notion_personal'
  AND credential_ref = 'NOTION_API_KEY';

-- Migration complete: notion_work config uses the *_source_* key names the live
-- schema reads, and notion_personal points at its own credential env var.

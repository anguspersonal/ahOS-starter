-- Migration 087: declare the Daily Log `Synthesis Status` property in dos_hl_config (#678)
--
-- WHY
-- The #561 unattended fallback sweep shipped, is wired, and has tests -- and was a
-- no-op in production, for every domain. Its own prerequisite ("no property, no
-- sweep") requires the Daily Log to carry a STRUCTURAL unconfirmed marker, because
-- a prose disclaimer gets skimmed and the entry then reads as the owner's own
-- account of that day (ADR-051 section 13). Neither Daily Log database had one, so
-- the skill correctly reported `sweep disabled: daily log has no unconfirmed/draft
-- property` every night and wrote nothing (#678).
--
-- The owner has now added the property by hand in Notion, to BOTH Daily Log
-- databases (verified 2026-08-21 by direct REST read):
--
--   Synthesis Status -- select -- options: Confirmed, Unconfirmed
--
-- This migration is the repo half: declare it in `daily_log_schema.properties` so
-- the skill reads the real name and the real option values VERBATIM from config
-- rather than guessing them. That is the same discipline migration 086 established
-- for the pillar checkbox names -- Notion property names live in config, never in
-- the skill file, so the owner can rename them without a code change.
--
-- WHY A SELECT, NOT THE CHECKBOX #678 ASKED FOR
-- #678's body suggested an `Unconfirmed` checkbox, or an `Unconfirmed` option on
-- the existing `Type` select. The owner shipped a dedicated two-option select
-- instead, and it is the better shape:
--
--   * A closed option set makes a typo impossible. A rich_text marker, or a
--     free-typed `Type` option, can drift to "unconfirmed", "UNCONFIRMED" or
--     "Unconfirmed " and silently stop matching any filter.
--   * It does not overload `Type`, which already means Daily / Catch-up / Weekly
--     Reflection -- an orthogonal axis. A swept entry is a `Daily` entry that
--     happens to be unconfirmed; collapsing the two axes would lose one of them.
--   * Crucially it makes BLANK distinct from CONFIRMED. An absent checkbox is
--     indistinguishable from an unticked one, so "nobody confirmed this" and "the
--     write failed" would look identical.
--
-- THE VALUE SET IS TOTAL -- WHICH IS WHY `required` IS TRUE
-- Every Daily Log entry carries exactly one of these values. The sweep writes
-- `Unconfirmed`; the ordinary attended ritual writes `Confirmed` (dos-hl Step 8,
-- widened in the same PR as this migration). Leaving attended entries blank would
-- make a blank mean two things at once -- "a human wrote this" and "the property
-- write silently failed" -- and distinguishing them would need a human to read the
-- page and judge, which is exactly the interpretation a structural marker exists
-- to remove. Under a total value set a blank has one meaning, a broken write, and
-- it is visible as one at a glance.
--
-- ORDERING
-- Purely additive and backward-compatible, per AGENTS.md. `dailyLogPropertySchema`
-- in packages/mcp-server/src/dosHlConfig.ts is already a generic
-- {name, notion_type, required, notes?} array and `get_dos_hl_config` already
-- prints arbitrary properties, so no deployed code reads this entry by name and
-- none breaks on it. It can land either side of the code that consumes it.
--
-- Idempotent: re-running is a no-op once a property named `Synthesis Status` is
-- present. Pure DML over a JSONB blob; no DDL, no function signatures.

-- Append the property to every row whose daily_log_schema does not already declare
-- it. Containment (`@>`) is the presence test rather than an unnested subquery so
-- that a malformed blob returns false instead of raising, and the type guards keep
-- jsonb_set off any row whose `daily_log_schema` is not an object.
update user_preferences
set dos_hl_config = jsonb_set(
  dos_hl_config,
  '{daily_log_schema,properties}',
  coalesce(dos_hl_config -> 'daily_log_schema' -> 'properties', '[]'::jsonb) || '[
    {
      "name": "Synthesis Status",
      "notion_type": "select",
      "required": true,
      "notes": "Confirmed / Unconfirmed. Unconfirmed marks a machine-written draft nobody has reviewed (#561 sweep); attended runs write Confirmed. Every entry carries one value: a blank means a failed write, not a meaning."
    }
  ]'::jsonb,
  true
)
where dos_hl_config is not null
  and jsonb_typeof(dos_hl_config -> 'daily_log_schema') = 'object'
  and coalesce(jsonb_typeof(dos_hl_config -> 'daily_log_schema' -> 'properties'), 'array') = 'array'
  and not coalesce(
    dos_hl_config -> 'daily_log_schema' -> 'properties' @> '[{"name": "Synthesis Status"}]'::jsonb,
    false
  );

comment on column user_preferences.dos_hl_config is
  'dos-hl skill config: workspace entity signals, pillars, domain list, artefact register tones, atom type definitions, tone rules, state doc caps, and daily log DB schema. Fetched at runtime via get_dos_hl_config MCP tool. Shape: { workspace, pillars, domains, artefact_registers, types, tone, state_doc_rules, daily_log_schema }. A pillar is a strategic objective ({key, label, description, notion_property}) and is NOT task priority -- priority means the Tasks DB P0-P4 urgency scale only (#618). notion_property is the Daily-Log checkbox property name, stored verbatim so internal keys can be renamed without touching Notion (#470). daily_log_schema.properties is likewise the verbatim declaration of the Notion Daily Log properties, including the Synthesis Status select (Confirmed / Unconfirmed) that the #561 unattended sweep requires and that every entry carries exactly one value of (#678).';

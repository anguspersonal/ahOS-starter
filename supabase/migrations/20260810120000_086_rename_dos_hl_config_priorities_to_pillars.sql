-- Migration 086: rename user_preferences.dos_hl_config.priorities -> .pillars (#618)
--
-- WHY
-- "Priority" named two different things. Task urgency is P0-P4 in the Notion Tasks
-- DB (#471). Strategic objectives are Work's four company pillars, and #411
-- already decided those are called PILLARS -- but the config key kept the losing
-- name, so `dos_hl_config.priorities` was still the thing generating the Notion
-- Daily-Log checkbox property names. ADR-054 section 5 makes this rename a
-- precondition for authoring per-domain pillars.
--
-- THE ONE THING THIS MIGRATION MUST NOT DO
-- Break the Daily Log write. Before #618 the dos-hl skill derived each checkbox
-- property name as "{key} {label}", i.e. "P1 Launch", and the matching Notion
-- properties are still called P1-P4. Renaming the keys to "Pillar 1"-"Pillar 4"
-- would silently start writing to "Pillar 1 Launch", which does not exist in
-- Notion until the owner does #470 (needs-angus, a manual Notion mutation).
--
-- So this migration DECOUPLES the two: every pillar gains an explicit
-- `notion_property` pinned to its CURRENT derived value ("P1 Launch"), and the
-- code + skill now read that string verbatim instead of re-deriving it. Internal
-- vocabulary changes here; the external Notion property names do not change at
-- all. #470 later flips the Notion properties and these `notion_property` values
-- together, with no code change required.
--
-- ORDERING
-- Backward-compatible only in one direction, per AGENTS.md: the code that reads
-- `pillars` must be deployed BEFORE this runs. Code shipped in the same PR reads
-- `pillars` first and falls back to `priorities`, so it is correct either side of
-- this migration; the previous deployed code reads `priorities` only and would see
-- an empty pillar list. Apply on the release train that carries that code, not
-- ahead of it.
--
-- Idempotent: re-running is a no-op once every row has `pillars` and no
-- `priorities`. Pure DML over a JSONB blob; no DDL, no function signatures.

-- 1. Rows still on the old key: build `pillars` from `priorities`, then drop it.
--    "P1" -> "Pillar 1" (only for keys that actually match the P<digits> shape --
--    anything else keeps its key rather than being mangled), and pin
--    `notion_property` to the pre-rename derived name so Notion is untouched.
update user_preferences
set dos_hl_config = (dos_hl_config - 'priorities') || jsonb_build_object(
  'pillars',
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'key',
          case
            when p ->> 'key' ~ '^P[0-9]+$' then 'Pillar ' || substring(p ->> 'key' from 2)
            else p ->> 'key'
          end,
          'label', coalesce(p ->> 'label', ''),
          'description', coalesce(p ->> 'description', ''),
          'notion_property',
          coalesce(
            nullif(btrim(coalesce(p ->> 'notion_property', '')), ''),
            btrim(coalesce(p ->> 'key', '') || ' ' || coalesce(p ->> 'label', ''))
          )
        )
        order by ord
      )
      from jsonb_array_elements(dos_hl_config -> 'priorities') with ordinality as t(p, ord)
    ),
    '[]'::jsonb
  )
)
where dos_hl_config ? 'priorities'
  and not (dos_hl_config ? 'pillars')
  and jsonb_typeof(dos_hl_config -> 'priorities') = 'array';

-- 2. Rows that somehow carry both keys: `pillars` is authoritative (that is the
--    precedence the reader implements), so drop the dead `priorities` key rather
--    than leaving two lists free to disagree.
update user_preferences
set dos_hl_config = dos_hl_config - 'priorities'
where dos_hl_config ? 'priorities'
  and dos_hl_config ? 'pillars';

comment on column user_preferences.dos_hl_config is
  'dos-hl skill config: workspace entity signals, pillars, domain list, artefact register tones, atom type definitions, tone rules, state doc caps, and daily log DB schema. Fetched at runtime via get_dos_hl_config MCP tool. Shape: { workspace, pillars, domains, artefact_registers, types, tone, state_doc_rules, daily_log_schema }. A pillar is a strategic objective ({key, label, description, notion_property}) and is NOT task priority -- priority means the Tasks DB P0-P4 urgency scale only (#618). notion_property is the Daily-Log checkbox property name, stored verbatim so internal keys can be renamed without touching Notion (#470).';

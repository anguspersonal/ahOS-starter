-- Migration 089: pillars project into a `Pillars` multi-select, not per-objective
-- checkbox properties (#692)
--
-- WHAT ALREADY HAPPENED IN NOTION, BEFORE THIS FILE WAS WRITTEN
-- Both Daily Logs (Work `3499e609-fe01-8046-913a-d59df0ce9b9d`, personal
-- `35ab7b8b-edcd-811a-a3bc-e37d4ced1d87`) gained a `Pillars` multi_select; every
-- historical tick was backfilled into it VERBATIM (a May entry that said `P1 Launch`
-- still says `P1 Launch`, never `Product`), verified page by page; and the pillar
-- checkbox properties were then DELETED. That work is done and is not reversible.
-- `Reflection included` is a checkbox but is not a pillar; it survives and is now the
-- only checkbox on either database.
--
-- WHY
-- A pillar objective was a checkbox property NAMED after the objective, which puts
-- time-varying content in the schema. Changing an objective left two moves and both
-- are bad: rename the property, and Notion rewrites what every historical tick meant;
-- or leave it, and the schema names something retired. Both happened. One multi-select
-- whose option names are IMMUTABLE IDENTITIES replaces them (#692, superseding the
-- rename approach in #656).
--
-- THE RULE THIS MIGRATION EXISTS TO WRITE DOWN
-- **Never rename a `Pillars` option, only add.** A changed objective is a NEW option;
-- the retired one simply stops being selected and stays in Notion so history still
-- reads correctly. Renaming reintroduces the exact defect being removed. The rule is
-- carried in the `Pillars` property notes below so it lands in front of the next
-- person to change a pillar, not only in this header.
--
-- WHAT THIS MIGRATION CHANGES
--   1. `pillars[].notion_property` -> `pillars[].notion_option`. The field no longer
--      names a Notion PROPERTY; it carries an option VALUE inside one. Keeping the old
--      name would leave "property" meaning two different things in one blob, since the
--      containing property is now declared separately in `daily_log_schema.properties`
--      (the ambiguity migration 088 refused when it declined to reuse `domains`).
--   2. `work.pillars` is REPLACED with the four current objectives, in the owner's
--      words of 2026-08-21. The four retired options (`P1 Launch`, `P2 Round`,
--      `P3 EHS`, `P4 Retention/WTP`) stay in NOTION so history reads correctly, and
--      are deliberately absent from config: config describes what is currently
--      SELECTABLE, not everything that was ever selected.
--   3. `angus.pillars` KEEPS all five labels and descriptions and every option string.
--      Only the key changes. **THIS IS NOT A NO-OP AND MUST NOT BE DELETED AS ONE:**
--      the five strings (`P1 Laura` etc.) are textually identical before and after, but
--      they stop meaning "the name of a checkbox property" and start meaning "an option
--      value in the `Pillars` multi-select". The checkbox properties those strings named
--      no longer exist; the options do, because the backfill carried the names over.
--   4. `Pillars` is DECLARED in `daily_log_schema.properties` for both domains. It is a
--      real Notion property and nothing declared it, so the only record of the pillar
--      destination was a field named after the old one.
--   5. Two exact phrasings of the `Other domains` note that mention pillar checkboxes
--      (migration 055's and migration 088's) are corrected. Only those two phrasings are
--      touched; any other note text is carried verbatim.
--
-- ORDERING, AND THE WINDOW THIS MIGRATION IS PUSHED IN
-- Per AGENTS.md a migration must not break the code already deployed, and migrations
-- reach prod by hand on the release train — so the reader ships BEFORE this runs, for
-- an unknown window. The reader therefore accepts BOTH shapes: `notion_option` is
-- preferred, and a pre-089 `notion_property` is read as an option value. That is the
-- only non-breaking reading available, not a convenience: the checkbox properties those
-- strings used to name are already gone from Notion, so treating them as property names
-- would fail every Daily Log write for the whole window, while reading them as options
-- hits live options the backfill preserved. `packages/mcp-server/src/dosHlConfig.test.ts`
-- pins that both ways round.
--
-- 088 IS A PRECONDITION. This operates on the post-088 `by_domain` shape only. A blob
-- with no `by_domain` (or an empty one) predates 088 and is SKIPPED rather than
-- rewritten: its pillars live under flat top-level keys this file does not address, and
-- half-applying a per-domain edit to a flat blob would corrupt it. Such a row keeps
-- working, because the reader's flat fallback serves it and reads its `notion_property`
-- as an option exactly as it does post-088.
--
-- SAFETY
-- Idempotent by construction rather than by guard: every write below is a fixpoint, so
-- a second run produces a byte-identical blob. Every key read is type-guarded, so a
-- malformed or half-shaped blob is SKIPPED, never rewritten. The two domains are
-- updated by two independent statements so neither depends on the other being present.
-- Pure DML over a JSONB blob; no DDL, no function signatures.

-- 1. work: replace the pillars with the current objectives, declare `Pillars`.
update user_preferences
set dos_hl_config = jsonb_set(
  dos_hl_config,
  '{by_domain,work}',
  (dos_hl_config -> 'by_domain' -> 'work')
  || jsonb_build_object(
    -- Owner-confirmed 2026-08-21. `key` stays `Pillar N` (migration 086 / #618):
    -- internal vocabulary, moving on its own schedule from the Notion strings.
    -- `label` and `notion_option` coincide here; they are still two fields, because
    -- the option is the immutable Notion identity and the label is prose.
    'pillars',
    '[
      {"key": "Pillar 1", "label": "Product",    "description": "Deliver exceptional product",         "notion_option": "Product"},
      {"key": "Pillar 2", "label": "Operations", "description": "Maintain the business",               "notion_option": "Operations"},
      {"key": "Pillar 3", "label": "Investment", "description": "Raise investment",                    "notion_option": "Investment"},
      {"key": "Pillar 4", "label": "Marketing",  "description": "Grow the business through marketing", "notion_option": "Marketing"}
    ]'::jsonb,
    'daily_log_schema',
    jsonb_set(
      dos_hl_config -> 'by_domain' -> 'work' -> 'daily_log_schema',
      '{properties}',
      coalesce(
        (
          select jsonb_agg(
            case
              when jsonb_typeof(p -> 'notes') = 'string'
                then p || jsonb_build_object(
                  'notes',
                  replace(
                    replace(
                      p ->> 'notes',
                      'Cross-cutting domains not covered by priority checkboxes',
                      'Cross-cutting topics not covered by the pillars'
                    ),
                    'Cross-cutting topics not covered by the pillar checkboxes',
                    'Cross-cutting topics not covered by the pillars'
                  )
                )
              else p
            end
            order by ord
          )
          from jsonb_array_elements(
            dos_hl_config -> 'by_domain' -> 'work' -> 'daily_log_schema' -> 'properties'
          ) with ordinality as t(p, ord)
          -- Drop any existing `Pillars` declaration and re-append the canonical one,
          -- so a re-run converges instead of accumulating or diverging.
          where coalesce(p ->> 'name', '') <> 'Pillars'
        ),
        '[]'::jsonb
      ) || '[
        {
          "name": "Pillars",
          "notion_type": "multi_select",
          "required": false,
          "notes": "Which pillars the day advanced; the option values come from pillars[].notion_option and are written verbatim, and a day that advanced none selects nothing. NEVER RENAME AN OPTION, ONLY ADD. An option name is the immutable identity of an objective, so renaming it silently rewrites what every historical entry meant, which is the defect #692 removed by deleting the per-objective checkbox properties. A changed objective is a NEW option; the retired one simply stops being selected and stays in Notion so history still reads correctly. Never invent a value either: Notion CREATES an unknown multi-select option on write, so a guessed string adds a pillar identity instead of failing."
        }
      ]'::jsonb,
      true
    )
  ),
  false
)
where dos_hl_config is not null
  and jsonb_typeof(dos_hl_config) = 'object'
  -- Post-088 only. An absent or empty `by_domain` means the blob is still flat, which
  -- matches how the reader decides the same question.
  and jsonb_typeof(dos_hl_config -> 'by_domain') = 'object'
  and dos_hl_config -> 'by_domain' <> '{}'::jsonb
  -- Every key read below must be the type it claims to be, or the row is skipped.
  and jsonb_typeof(dos_hl_config -> 'by_domain' -> 'work') = 'object'
  and jsonb_typeof(dos_hl_config -> 'by_domain' -> 'work' -> 'daily_log_schema') = 'object'
  and jsonb_typeof(
    dos_hl_config -> 'by_domain' -> 'work' -> 'daily_log_schema' -> 'properties'
  ) = 'array';

-- 2. angus: rename the field on every pillar, keeping each value, and declare
--    `Pillars`. The pillars are TRANSFORMED rather than replaced with a literal, so a
--    pillar the owner added by hand since 088 survives instead of being deleted.
update user_preferences
set dos_hl_config = jsonb_set(
  dos_hl_config,
  '{by_domain,angus}',
  (dos_hl_config -> 'by_domain' -> 'angus')
  || jsonb_build_object(
    'pillars',
    coalesce(
      (
        select jsonb_agg(
          case
            -- Junk survives untouched rather than aborting the migration: `-` on a
            -- non-object jsonb raises, and one malformed element must not take the
            -- whole push down.
            when jsonb_typeof(p) <> 'object' then p
            -- A pillar that projected keeps projecting, to the same string, which now
            -- names an option rather than a property. A pillar that never projected
            -- gains nothing: absence still means "this pillar writes nothing".
            when coalesce(p ->> 'notion_option', p ->> 'notion_property') is null
              then p - 'notion_property'
            else (p - 'notion_property')
              || jsonb_build_object(
                'notion_option',
                coalesce(p ->> 'notion_option', p ->> 'notion_property')
              )
          end
          order by ord
        )
        from jsonb_array_elements(
          dos_hl_config -> 'by_domain' -> 'angus' -> 'pillars'
        ) with ordinality as t(p, ord)
      ),
      '[]'::jsonb
    ),
    'daily_log_schema',
    jsonb_set(
      dos_hl_config -> 'by_domain' -> 'angus' -> 'daily_log_schema',
      '{properties}',
      coalesce(
        (
          select jsonb_agg(
            case
              when jsonb_typeof(p -> 'notes') = 'string'
                then p || jsonb_build_object(
                  'notes',
                  replace(
                    replace(
                      p ->> 'notes',
                      'Cross-cutting domains not covered by priority checkboxes',
                      'Cross-cutting topics not covered by the pillars'
                    ),
                    'Cross-cutting topics not covered by the pillar checkboxes',
                    'Cross-cutting topics not covered by the pillars'
                  )
                )
              else p
            end
            order by ord
          )
          from jsonb_array_elements(
            dos_hl_config -> 'by_domain' -> 'angus' -> 'daily_log_schema' -> 'properties'
          ) with ordinality as t(p, ord)
          where coalesce(p ->> 'name', '') <> 'Pillars'
        ),
        '[]'::jsonb
      ) || '[
        {
          "name": "Pillars",
          "notion_type": "multi_select",
          "required": false,
          "notes": "Which pillars the day advanced; the option values come from pillars[].notion_option and are written verbatim, and a day that advanced none selects nothing. NEVER RENAME AN OPTION, ONLY ADD. An option name is the immutable identity of an objective, so renaming it silently rewrites what every historical entry meant, which is the defect #692 removed by deleting the per-objective checkbox properties. A changed objective is a NEW option; the retired one simply stops being selected and stays in Notion so history still reads correctly. Never invent a value either: Notion CREATES an unknown multi-select option on write, so a guessed string adds a pillar identity instead of failing."
        }
      ]'::jsonb,
      true
    )
  ),
  false
)
where dos_hl_config is not null
  and jsonb_typeof(dos_hl_config) = 'object'
  and jsonb_typeof(dos_hl_config -> 'by_domain') = 'object'
  and dos_hl_config -> 'by_domain' <> '{}'::jsonb
  and jsonb_typeof(dos_hl_config -> 'by_domain' -> 'angus') = 'object'
  and jsonb_typeof(dos_hl_config -> 'by_domain' -> 'angus' -> 'pillars') = 'array'
  and jsonb_typeof(dos_hl_config -> 'by_domain' -> 'angus' -> 'daily_log_schema') = 'object'
  and jsonb_typeof(
    dos_hl_config -> 'by_domain' -> 'angus' -> 'daily_log_schema' -> 'properties'
  ) = 'array';

comment on column user_preferences.dos_hl_config is
  'dos ritual config, split per ADR-054 section 5 into per-domain behaviour and global behaviour. Fetched at runtime via the get_dos_hl_config MCP tool, which takes an optional domain argument defaulting to work. Shape: { by_domain: { work: <domain config>, angus: <domain config> }, types, tone }. A DOMAIN CONFIG is { topics, pillars, domain_signals, artefact_registers, state_doc_rules, daily_log_schema }: topics is the subject-area taxonomy used to classify an item (renamed from the old top-level domains key, since domain now means only ADR-051 section 1 routing axis work|angus); domain_signals is the classifier deciding which domain an item routes to (repurposed from workspace.work_entities / workspace.personal_signals). types and tone are global -- identical whichever domain a night routes to. A PILLAR is a strategic objective ({key, label, description, notion_option}) and is NOT task priority -- priority means the Tasks DB P0-P4 urgency scale only (#618). notion_option is the value the pillar writes into the Daily Log Pillars multi_select, stored verbatim so internal keys can be renamed without touching Notion; it is an OPTION VALUE, not a property name, and NEVER RENAME AN OPTION, ONLY ADD -- an option name is an objectives immutable identity, so renaming it rewrites what every historical entry meant, which is the defect #692 removed by replacing the per-objective checkbox properties. Pre-089 blobs carry the same string under notion_property and readers accept it as an option value. daily_log_schema.properties is likewise the verbatim declaration of that domains Notion Daily Log properties, including the Pillars multi_select the pillars project into (#692), and the Synthesis Status select (Confirmed / Unconfirmed) that the #561 unattended sweep requires and that every entry carries exactly one value of (#678). The angus block ratifies the personal Daily Log as it already exists in Notion, five owner-authored pillars included (#679). Readers accept the pre-088 flat shape as a fallback so the deployed server works either side of these migrations.';

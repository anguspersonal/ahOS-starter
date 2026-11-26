-- Migration 055: extend dos_hl_config with types, tone, state_doc_rules, daily_log_schema
-- Moves the remaining REFERENCE.md content into the DB so the dos-hl skill can
-- fetch everything at runtime via get_dos_hl_config and no longer reads a bundled file.
-- See ADR-030.

-- Merge new fields into existing rows (||  merges JSONB, existing keys are preserved).
update user_preferences
set dos_hl_config = coalesce(dos_hl_config, '{}'::jsonb) || '{
  "types": [
    {"key": "Note",               "description": "Passive observation, status, factual update. Default when nothing fancier applies."},
    {"key": "Artefact",           "description": "A draft message, email, post, code snippet, or document. Full text typically in the atom body."},
    {"key": "Decision",           "description": "A decision made, locked in, or recently changed."},
    {"key": "State change",       "description": "Something materially changed (submission status, role, relationship)."},
    {"key": "Question for Angus", "description": "Something requiring attention or a decision."}
  ],
  "tone": [
    "Direct, terse, lowercase if matching user register (Slack-style for short confirmations)",
    "Plain British English, no jargon",
    "NEVER use the em-dash — use commas, semicolons, parentheses, or sentence breaks instead",
    "No corporate fluff",
    "Push back when warranted; do not soften useful challenge",
    "When confirming actions, brief: Done. [URL]"
  ],
  "state_doc_rules": {
    "max_words": 2000,
    "open_actions_cap": 10,
    "communications_cap": 10
  },
  "daily_log_schema": {
    "properties": [
      {"name": "Name",               "notion_type": "title",        "required": true,  "notes": "DD Month, 1-5 word summary"},
      {"name": "Date",               "notion_type": "date",         "required": true,  "notes": "The date the entry covers, not when written"},
      {"name": "Type",               "notion_type": "select",       "required": true,  "notes": "Daily / Catch-up / Weekly Reflection"},
      {"name": "Summary",            "notion_type": "rich_text",    "required": true,  "notes": "50-word elevator pitch of the day"},
      {"name": "Other domains",      "notion_type": "multi_select", "required": false, "notes": "Cross-cutting domains not covered by priority checkboxes"},
      {"name": "Reflection included","notion_type": "checkbox",     "required": false, "notes": "True if the user reflected during this entry"},
      {"name": "Artefacts generated","notion_type": "multi_select", "required": false, "notes": "Bri, Team, Mitesh, Investor, Advisor, Personal Log, Other"}
    ],
    "body_sections": ["What I did", "What happened", "Open / blocked", "Reflection", "Artefacts generated"]
  }
}'::jsonb
where dos_hl_config is not null;

-- For rows that had no config yet (e.g. new installs), seed the full default.
update user_preferences
set dos_hl_config = '{
  "workspace": {"work_entities": [], "personal_signals": []},
  "priorities": [],
  "domains": [],
  "artefact_registers": [],
  "types": [
    {"key": "Note",               "description": "Passive observation, status, factual update. Default when nothing fancier applies."},
    {"key": "Artefact",           "description": "A draft message, email, post, code snippet, or document. Full text typically in the atom body."},
    {"key": "Decision",           "description": "A decision made, locked in, or recently changed."},
    {"key": "State change",       "description": "Something materially changed (submission status, role, relationship)."},
    {"key": "Question for Angus", "description": "Something requiring attention or a decision."}
  ],
  "tone": [
    "Direct, terse, lowercase if matching user register",
    "Plain British English, no jargon",
    "NEVER use the em-dash — use commas, semicolons, parentheses, or sentence breaks instead",
    "No corporate fluff",
    "Push back when warranted; do not soften useful challenge",
    "When confirming actions, brief: Done. [URL]"
  ],
  "state_doc_rules": {
    "max_words": 2000,
    "open_actions_cap": 10,
    "communications_cap": 10
  },
  "daily_log_schema": {
    "properties": [
      {"name": "Name",               "notion_type": "title",        "required": true,  "notes": "DD Month, 1-5 word summary"},
      {"name": "Date",               "notion_type": "date",         "required": true,  "notes": "The date the entry covers, not when written"},
      {"name": "Type",               "notion_type": "select",       "required": true,  "notes": "Daily / Catch-up / Weekly Reflection"},
      {"name": "Summary",            "notion_type": "rich_text",    "required": true,  "notes": "50-word elevator pitch of the day"},
      {"name": "Other domains",      "notion_type": "multi_select", "required": false, "notes": "Cross-cutting domains not covered by priority checkboxes"},
      {"name": "Reflection included","notion_type": "checkbox",     "required": false, "notes": "True if the user reflected during this entry"},
      {"name": "Artefacts generated","notion_type": "multi_select", "required": false, "notes": "Bri, Team, Mitesh, Investor, Advisor, Personal Log, Other"}
    ],
    "body_sections": ["What I did", "What happened", "Open / blocked", "Reflection", "Artefacts generated"]
  }
}'::jsonb
where dos_hl_config is null;

comment on column user_preferences.dos_hl_config is
  'dos-hl skill config: workspace entity signals, priorities, domain list, artefact register tones, atom type definitions, tone rules, state doc caps, and daily log DB schema. Fetched at runtime via get_dos_hl_config MCP tool. Shape: { workspace, priorities, domains, artefact_registers, types, tone, state_doc_rules, daily_log_schema }.';

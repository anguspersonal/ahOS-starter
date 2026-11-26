-- Migration 050: add dos_eod_config to user_preferences
-- Stores user-specific dos-eod opinions: workspace entity signals, priorities,
-- domains, and artefact registers. Keeps the dos-eod skill shareable across
-- model vendors — config is fetched via get_dos_eod_config at runtime, not
-- loaded from a file bundled with the skill.

alter table user_preferences
  add column if not exists dos_eod_config jsonb;

-- Seed the owner's row with current Work v1 values.
-- Update the user_id value to match your auth.users row.
update user_preferences
set dos_eod_config = '{
  "workspace": {
    "work_entities": [
      "Work", "Lina", "EHS", "Briana", "Mitesh",
      "Apple submission", "the round", "pricing", "App Store"
    ],
    "personal_signals": [
      "private health", "family", "friends", "side projects"
    ]
  },
  "priorities": [
    {"key": "P1", "label": "Launch",         "description": "Launch the app and nail the chat experience"},
    {"key": "P2", "label": "Round",          "description": "Raise the next funding round"},
    {"key": "P3", "label": "EHS",            "description": "Validate the EHS system"},
    {"key": "P4", "label": "Retention/WTP",  "description": "Prove retention and willingness to pay"}
  ],
  "domains": [
    "Apple", "Google Play", "Round", "Product", "EHS",
    "Pricing", "Team", "Advisors", "Legal", "Ops", "Personal", "Other"
  ],
  "artefact_registers": [
    {"key": "Bri",      "tone": "co-founder, signal not status, lowercase, conversational"},
    {"key": "Team",     "tone": "all-hands Slack message, bulleted, lowercase"},
    {"key": "Mitesh",   "tone": "contractor-scoped, technical, direct"},
    {"key": "Investor", "tone": "outcome-framed, polished, formal"},
    {"key": "Advisor",  "tone": "candid, signal-rich, with explicit asks for input"}
  ]
}'::jsonb
where dos_eod_config is null;

comment on column user_preferences.dos_eod_config is
  'dos-eod skill config: workspace entity signals, priorities, domain list, and artefact register tones. Fetched at runtime via get_dos_eod_config MCP tool. Shape: { workspace: { work_entities: string[], personal_signals: string[] }, priorities: [{key,label,description}], domains: string[], artefact_registers: [{key,tone}] }';

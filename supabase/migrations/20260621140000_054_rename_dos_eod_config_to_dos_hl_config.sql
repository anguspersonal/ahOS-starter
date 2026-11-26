-- Migration 054: rename dos_eod_config column to dos_hl_config
-- dos-eod skill renamed to dos-hl to differentiate from dos-personal and dos-infra.

ALTER TABLE user_preferences
  RENAME COLUMN dos_eod_config TO dos_hl_config;

COMMENT ON COLUMN user_preferences.dos_hl_config IS
  'dos-hl (Work daily OS) skill config: workspace entity signals, priorities, domains, artefact registers. See migration 050 for schema.';

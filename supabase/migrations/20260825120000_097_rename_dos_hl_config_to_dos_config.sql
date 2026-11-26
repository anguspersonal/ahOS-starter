-- Migration 097: rename user_preferences.dos_hl_config -> dos_config (#621, ADR-054 §7)
--
-- ADR-054 §7 already decided the target name, as part of retiring the four
-- forked dos-* skills into one `dos`. This is the column-rename half; the
-- JSONB value's own shape (by_domain, pillars, types, tone) is untouched --
-- migrations 086-090 already settled that, and this migration does not touch
-- their content.
--
-- Idempotent (safe to re-run, and safe if applied out of order relative to
-- any migration touching the same column): a plain column rename is a no-op
-- the second time, since `dos_hl_config` no longer exists to rename.

DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'user_preferences' AND column_name = 'dos_hl_config'
	) THEN
		ALTER TABLE user_preferences RENAME COLUMN dos_hl_config TO dos_config;
	END IF;
END $$;

COMMENT ON COLUMN user_preferences.dos_config IS
	'dos ritual config: per-domain (topics, pillars, domain_signals, artefact registers, state doc caps, daily log schema) plus global keys (atom types, tone). See migration 050 for the original schema and 086-090 for its evolution; the column itself was dos_eod_config (migration 054 renamed it to dos_hl_config), and this migration is the second rename, off the same ADR-054 §7 decision as the dos-hl skill unification.';

-- Migration 123: fold Notion Personal Style DB rules into dos_config.tone (#823)
--
-- Incorporates the approved rules from the Notion Personal Style DB into
-- user_preferences.dos_config.tone:
--   - Earn exclamation marks: use only for genuine good news; default to a full stop.
--   - Match the recipient's register: register-mirroring is the default warmth move.
--   - Do not repeat asks within the same thread if an ask or question is already on the table.
--   - Offer 2-3 labelled variants when stakes or audience are ambiguous, not a single best guess.
--   - Peer-casual reconnects: personal landmarks first, work second (two updates max), withhold detail to leave reason to meet in person, and kick the ball back at the end.
--   - No corporate vocabulary when describing personal or career updates (understated phrasing over corporate terms).
--
-- Precision and idempotence:
--   The WHERE clause checks that 'Earn exclamation marks%' does not already exist
--   in dos_config -> 'tone'. A second run updates 0 rows.
--
-- The Notion Personal Style database remains as a read-only human reading copy
-- per owner decision (2026-09-26).

SET statement_timeout = '30s';

UPDATE user_preferences
SET dos_config = jsonb_set(
	dos_config,
	'{tone}',
	(
		SELECT jsonb_agg(elem ORDER BY ord)
		FROM (
			SELECT elem, ord
			FROM jsonb_array_elements_text(dos_config -> 'tone') WITH ORDINALITY AS t(elem, ord)
			UNION ALL
			SELECT elem, ord + 1000000
			FROM unnest(ARRAY[
				'Earn exclamation marks: use only for genuine good news; default to a full stop.',
				'Match the recipient''s register: register-mirroring is the default warmth move.',
				'Do not repeat asks within the same thread if an ask or question is already on the table.',
				'Offer 2-3 labelled variants when stakes or audience are ambiguous, not a single best guess.',
				'Peer-casual reconnects: personal landmarks first, work second (two updates max), withhold detail to leave reason to meet in person, and kick the ball back at the end.',
				'No corporate vocabulary when describing personal or career updates (understated phrasing over corporate terms).'
			]) WITH ORDINALITY AS n(elem, ord)
			WHERE NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements_text(dos_config -> 'tone') AS existing
				WHERE existing LIKE 'Earn exclamation marks%'
			)
		) sub
	)
)
WHERE jsonb_typeof(dos_config -> 'tone') = 'array'
  AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(dos_config -> 'tone') AS existing
      WHERE existing LIKE 'Earn exclamation marks%'
  );

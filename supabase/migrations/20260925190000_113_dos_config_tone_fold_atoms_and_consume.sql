-- Migration 113: fold 6 correction atoms into dos_config.tone and mark them consumed (#648)
--
-- Incorporates rules from six correction/style atoms into user_preferences.dos_config.tone:
--   - 444881a3: Ban the "It's X, not Y" antithesis construction
--   - 486613c8: Label simplified content "Executive summary", never "Plain English"
--   - 0e0394ef / 9df2d048: Team-update register (outcome-framed, peer asks, availability)
--   - b2cbb00c: Concise technical change-summaries (1-3 sentences, technical vocabulary)
--   - c3a1ba20: Porting HTML into an app: keep layout, drop style
--
-- Then marks all 6 atoms consumed via artifact_external_links (kind='synthesized').
--
-- PROVIDER SCOPING (round-1 QA High, #1168): dos_config.tone is GLOBAL — server.ts's
-- buildInstructions comment says these rules "apply to ALL prose addressed to the
-- user, on every surface" — but a `synthesized` consumption marker is scoped by
-- `provider` (domains.ts's DOMAIN_PROVIDER; links.ts's scopeToDomain), and a
-- domain-scoped not_consumed read (search.ts) only matches its OWN domain's
-- provider (#677). A single row under one provider would make these atoms
-- consumed for that domain's ritual only, while the other domain's day-window
-- read keeps seeing them as unconsumed forever — the exact "capture works,
-- retrieval/consumption doesn't" bug #648 exists to fix. Since the rules are
-- global, both DOMAIN_PROVIDER values ('notion_work' and 'notion_personal')
-- get their own marker row per atom, so whichever domain's ritual runs next
-- treats all 6 atoms as consumed rather than resurfacing them.

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
				'Ban the "It''s X, not Y" antithesis construction (e.g. "A reflex, not a price objection"). State claims directly without manufactured contrast.',
				'Label simplified content "Executive summary" (or neutral audience headings), never "Plain English" or "For non-technical users".',
				'Team updates: translate to outcomes, frame as peer-to-peer asks, and report availability rather than a task plan.',
				'Concise technical change-summaries: default to 1-3 sentences with real technical names stating what changed and why.',
				'When porting HTML into an app, preserve layout and geometry, drop external stylesheets, and use the app''s own design system tokens.'
			]) WITH ORDINALITY AS n(elem, ord)
			WHERE NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements_text(dos_config -> 'tone') AS existing
				WHERE existing LIKE 'Ban the "It''s X, not Y"%'
			)
		) sub
	)
)
WHERE jsonb_typeof(dos_config -> 'tone') = 'array';

INSERT INTO artifact_external_links (user_id, artifact_id, provider, kind, external_id)
SELECT a.user_id, a.id, p.provider, 'synthesized', 'tone_layer_issue_648'
FROM artifacts a
CROSS JOIN (VALUES ('notion_work'), ('notion_personal')) AS p(provider)
WHERE a.id IN (
	'444881a3-4e78-4d8d-be29-8bb5ca001c20',
	'486613c8-7bc0-44e4-918a-5a9c94a855c0',
	'0e0394ef-34d5-461f-9f70-03a090512527',
	'9df2d048-d35e-4787-8a9b-a0b1ca21e37c',
	'b2cbb00c-3fcc-47e3-ac26-a0e93897ee34',
	'c3a1ba20-e161-4d62-8f02-e8350768d964'
)
ON CONFLICT (artifact_id, provider, kind, external_id) DO NOTHING;

-- Migration 100: the em-dash rule stops breaking itself (#823 item 3, #648).
--
-- `user_preferences.dos_config.tone[2]` reads:
--
--     NEVER use the em-dash <EM DASH> use commas, semicolons, parentheses, or
--     sentence breaks instead
--
-- and the character standing where <EM DASH> is written above is an em-dash.
-- The rule violates itself.
--
-- WHY IT MATTERS NOW RATHER THAN WHENEVER:
--   Before #819 this was a curiosity in a config blob almost nothing read. #819
--   pushed the tone rules into the MCP `instructions` handshake, so they are now
--   in context before the first token of EVERY session on EVERY surface. The
--   contradiction ships with them, every time. #648 counted six instances of
--   agents breaking this exact rule; an instruction that demonstrates the
--   opposite of what it asks for is not a neutral defect.
--
-- WHY A MIGRATION:
--   `update_user_preferences` deliberately excludes `dos_config` (ADR-030 keeps
--   this blob under a reviewed edit flow rather than an open tool), so a data
--   fix here is a migration, exactly as migrations 086-090 were. (099 does the
--   same for the dos_config column comment and is in flight separately as #963;
--   it is not present in this branch, so this is a forward reference.)
--
-- WHY THE STATEMENT USES chr(8212) RATHER THAN THE CHARACTER:
--   A migration that removed an em-dash by embedding one in its own matching
--   condition would be the same joke one level down. It also keeps the statement
--   safe under any encoding surprise between this file and the database.
--
--   The 099 sibling migration and an earlier draft of this header both went
--   further and claimed the FILE contained no em-dash at all. That was false: a
--   round-1 review found one in this very comment block, in the sentence saying
--   there were none. Fixed, and the claim narrowed to what is actually checkable
--   and load-bearing, which is the matching condition rather than the prose.
--
-- PRECISION AND IDEMPOTENCE:
--   The WHERE clause fires only when a tone rule BOTH begins 'NEVER use the
--   em-dash' AND still contains one. So:
--     - a second run matches nothing and writes nothing;
--     - no other tone rule is read or rewritten, whatever it contains;
--     - a row whose rule has already been fixed by hand is left alone;
--     - array ORDER is preserved (WITH ORDINALITY), so tone[2] stays tone[2]
--       and #648's reference to it keeps resolving.
--
-- NOT IN SCOPE. #823 stays open. Its other items need live reads and writes
-- that are not a migration's business: auditing the Notion "Personal Style"
-- database, migrating anything unique out of it, and archiving the
-- personal-style skill in the capability registry.

UPDATE user_preferences
SET dos_config = jsonb_set(
	dos_config,
	'{tone}',
	(
		SELECT jsonb_agg(
			CASE
				WHEN rule #>> '{}' LIKE 'NEVER use the em-dash%'
					THEN to_jsonb('NEVER use the em-dash. Use commas, semicolons, parentheses, or sentence breaks instead.'::text)
				ELSE rule
			END
			ORDER BY ord
		)
		FROM jsonb_array_elements(dos_config -> 'tone') WITH ORDINALITY AS t(rule, ord)
	)
)
WHERE jsonb_typeof(dos_config -> 'tone') = 'array'
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements_text(dos_config -> 'tone') AS r
		WHERE r LIKE 'NEVER use the em-dash%'
			AND r LIKE '%' || chr(8212) || '%'
	);

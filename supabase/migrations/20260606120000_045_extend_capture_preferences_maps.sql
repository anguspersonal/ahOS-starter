-- Migration: Extend capture_preferences with user-specific "maps"
-- Date: 2026-06-06
-- Purpose:
--   The capture skill (.claude/skills/capture) is shared in a public repo and must
--   stay free of any one user's context. The user-specific bits — default tags,
--   default source channel, and routing "maps" (regex rules that auto-apply tags /
--   set a source channel) — are persisted here in user_preferences.capture_preferences
--   so they follow the user to any machine instead of living in the skill file.
--
--   capture_preferences shape (all keys optional; absent => prior behaviour):
--     {
--       "create_derived_artifacts": true,        // existing key (migration 035)
--       "default_tags": ["inbox"],               // always added to every capture
--       "default_source_channel": "mcp",         // source_channel when no rule matches
--       "tag_rules": [                            // first-match-wins ordering for channel
--         {
--           "match": "meeting|standup|1:1",      // case-insensitive regex
--           "in": "text",                        // "text" | "title" | "source_url"
--           "tags": ["work", "meeting"],         // tags to add when matched
--           "source_channel": "calendar"         // optional channel override
--         }
--       ]
--     }
-- Backward compatible: this only widens the JSONB default; existing rows keep their
-- values and code treats missing keys as empty.

-- Step 1: widen the column default so freshly-created rows carry the new keys.
ALTER TABLE user_preferences
ALTER COLUMN capture_preferences SET DEFAULT
  '{"create_derived_artifacts": true, "default_tags": [], "default_source_channel": "mcp", "tag_rules": []}'::jsonb;

-- Step 2: backfill the new keys onto existing rows without clobbering create_derived_artifacts.
UPDATE user_preferences
SET capture_preferences =
  '{"default_tags": [], "default_source_channel": "mcp", "tag_rules": []}'::jsonb
  || COALESCE(capture_preferences, '{}'::jsonb)
WHERE capture_preferences IS NULL
   OR NOT (capture_preferences ? 'tag_rules');

-- Step 3: document the contract on the column itself.
COMMENT ON COLUMN user_preferences.capture_preferences IS
  'Per-user capture settings consumed by the capture MCP tool / skill. Keys: create_derived_artifacts (bool), default_tags (text[]), default_source_channel (text), tag_rules (array of {match: regex, in: text|title|source_url, tags: text[], source_channel?: text}). See migration 045.';

-- Migration complete: capture_preferences now carries the user-specific capture maps.

-- Migration 049: make entity_relationships usable as knowledge-graph edges
-- Date: 2026-06-10
--
-- The entity<->entity edge table was effectively dead: the worker (and the new
-- MCP graph tools) write a `metadata` jsonb and edge types like `co_occurs_with`,
-- but (1) the `metadata` column never existed and (2) a rigid CHECK only allowed
-- belongs_to|related_to|mentions|depends_on|supersedes, so those inserts failed.
--
-- Fixes:
--   1. Add the missing `metadata` column.
--   2. Drop the rigid relationship_type CHECK. The edge vocabulary is now an open
--      set governed in the application layer (packages/mcp-server/src/vocab.ts),
--      so it can evolve without a migration -- a hard-coded DB enum drifting from
--      the code is what broke edge writes in the first place. relationship_type
--      stays NOT NULL; `no_self_reference` and the confidence-score bounds remain.

ALTER TABLE "public"."entity_relationships"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "public"."entity_relationships"
  DROP CONSTRAINT IF EXISTS "entity_relationships_relationship_type_check";

-- Migration complete: entity_relationships can now carry edge metadata and any
-- application-governed relationship_type.

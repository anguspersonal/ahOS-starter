-- Migration: add the self/user entity pointer + owner identity to user_preferences
-- ADR: ADR-024 (Self/User Entity)
-- Date: 2026-06-27
--
-- The knowledge graph had no first-class representation of the owner, so
-- "relationship to the user" edges (e.g. self -[engaged_to]-> Laura) and
-- dedupe-by-email ("this Angus is me") were unrepresentable. ADR-024 models the
-- owner as an ordinary entity_type='people' entity (so it participates in edges
-- and graph reads like anyone), pointed to by self_entity_id here, and marked
-- properties.is_self=true on the entity itself.
--
-- identity holds the owner's matching signals (emails + display name) so the
-- process_artifact skill can resolve references to the owner. It is deliberately
-- NOT seeded here (no personal data in migrations) — seed it via
-- update_user_preferences / get_self_entity.

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS self_entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL;

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS identity jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.user_preferences.self_entity_id IS
  'FK to the entities row representing the owner (entity_type=people, properties.is_self=true). One per user. See ADR-024.';
COMMENT ON COLUMN public.user_preferences.identity IS
  'Owner identity-matching signals: { "emails": ["a@example.com", ...], "display_name": "..." }. Used to dedupe references to the owner. Seeded at runtime, not in migrations. See ADR-024.';

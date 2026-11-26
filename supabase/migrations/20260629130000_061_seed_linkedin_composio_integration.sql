-- 061: seed a user_integrations row for LinkedIn member-post, routed via Composio (ADR-032).
-- Date: 2026-06-29
--
-- LinkedIn is the FIRST 'composio'-routed connector — the deliberate pilot for the rented-
-- upstream path (native LinkedIn is the worst onboarding in the set: a 60-day interactive
-- re-consent on a headless gateway; and a LinkedIn post is public, so only the token egresses).
--
-- No secret here. Composio holds the LinkedIn OAuth token in its vault; credential_ref points
-- to the Composio connected-account id and is filled in once you authorize LinkedIn in Composio.
-- status starts 'disconnected' (configured, not yet authorized) — post_linkedin returns a clear
-- "not connected" error until credential_ref is set.
--
-- To flip LinkedIn to a native POST /rest/posts adapter later: change routing to 'native'.
-- That single-row change is the whole point of the routing registry — no code change to callers.
INSERT INTO user_integrations (user_id, provider, routing, status, enabled, config)
SELECT
  id,
  'linkedin',
  'composio',
  'disconnected',
  true,
  jsonb_build_object('action', 'LINKEDIN_CREATE_LINKED_IN_POST', 'visibility', 'PUBLIC')
FROM auth.users
ON CONFLICT (user_id, provider) DO NOTHING;

-- Migration: PostHog connection rows are own_substrate, and point at their own env var
-- Date: 2026-08-24
-- Purpose:
--   ADR-060 introduced `<family>:<slug>` connection rows, and `posthog:work` was
--   created through set_integration_config. That tool deliberately cannot write
--   routing / status / credential_ref (they are infra-managed, ADR-032), so the row
--   took the column default of 'native'.
--
--   'native' is wrong here and wrong in a way that reads as settled fact:
--   get_integrations prints it, and ADR-032 explicitly classifies PostHog as
--   own_substrate — our own backend, reached directly, never through an aggregator.
--   Nothing dispatches on it today, which is exactly why it would have gone on
--   contradicting the ADR unnoticed.
--
--   credential_ref is filled in at the same time. Migration 060 set it for every
--   provider it backfilled and the column is documented as "POINTER to the auth,
--   never the secret: env var name (native)". Leaving PostHog rows null makes the
--   pointer look like it does not exist for connections, when in fact the convention
--   is `POSTHOG_API_KEY_<SLUG>` (credentials.ts, connectionEnvVar).
--
--   The derivation below mirrors connectionEnvVar exactly: uppercase the slug and
--   replace any non-alphanumeric run with an underscore. It is descriptive, not
--   load-bearing — getCredential derives the name from the provider at call time and
--   does not read this column. When ADR-045's vault swap lands, this column becomes
--   the thing it reads, which is the reason to keep it honest now.
--
--   Written to match ANY posthog:* row rather than the two that exist today, so a
--   connection added tomorrow through set_integration_config is not silently left
--   with the wrong routing. Re-runnable: the WHERE clause makes it a no-op once done.

UPDATE public.user_integrations
SET
  routing = 'own_substrate',
  credential_ref = COALESCE(
    credential_ref,
    'POSTHOG_API_KEY_' || upper(regexp_replace(split_part(provider, ':', 2), '[^a-zA-Z0-9]+', '_', 'g'))
  )
WHERE provider LIKE 'posthog:%'
  AND (routing IS DISTINCT FROM 'own_substrate' OR credential_ref IS NULL);

-- Migration complete: PostHog connection rows now agree with ADR-032 on routing, and
-- name the env var that holds their key.

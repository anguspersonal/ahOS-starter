-- 060: extend user_integrations with routing + connection-health columns (ADR-032).
-- Date: 2026-06-29
-- Purpose:
--   ADR-032 makes connector sourcing a per-provider decision (native | composio | mcp |
--   own_substrate) behind our one MCP send-tool port (ADR-017). This table becomes the
--   ROUTING REGISTRY that records, per provider, which upstream a send/read tool dispatches
--   to — and doubles as the connection-HEALTH ledger (status + token expiry), which is where
--   the LinkedIn/Instagram 60-day re-consent reminders will fire from.
--
--   SECRETS STILL DO NOT LIVE HERE. credential_ref is a POINTER, not a secret: for native it
--   names the env var holding the token (e.g. 'GOOGLE_REFRESH_TOKEN'); for composio it is the
--   Composio connected-account id. The token itself stays in env (native) or Composio's vault.

ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS routing         text        NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS status          text        NOT NULL DEFAULT 'connected',
  ADD COLUMN IF NOT EXISTS credential_ref  text,
  ADD COLUMN IF NOT EXISTS expires_at      timestamptz,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

-- routing: how a send/read tool reaches this provider behind our gateway port.
--   'native'        — thin in-house adapter, our token in env (the drive.ts / notion.ts pattern)
--   'composio'      — rented aggregator upstream (token held in Composio's vault)
--   'mcp'           — a self-hosted MCP server upstream
--   'own_substrate' — our OWN backend (Supabase / PostHog / Firebase): direct, never an aggregator
ALTER TABLE public.user_integrations DROP CONSTRAINT IF EXISTS user_integrations_routing_check;
ALTER TABLE public.user_integrations
  ADD CONSTRAINT user_integrations_routing_check
  CHECK (routing IN ('native', 'composio', 'mcp', 'own_substrate'));

-- status: connection health, distinct from `enabled` (the on/off feature flag).
--   'connected' | 'needs_reauth' (token expired / revoked) | 'disconnected' (configured, not yet
--   authorized) | 'error'.
ALTER TABLE public.user_integrations DROP CONSTRAINT IF EXISTS user_integrations_status_check;
ALTER TABLE public.user_integrations
  ADD CONSTRAINT user_integrations_status_check
  CHECK (status IN ('connected', 'needs_reauth', 'disconnected', 'error'));

-- Backfill existing rows: all current integrations are native (token in env). Point
-- credential_ref at the env var that holds each one's token, and derive status from enabled.
UPDATE public.user_integrations
SET
  routing = 'native',
  status = CASE WHEN enabled THEN 'connected' ELSE 'disconnected' END,
  credential_ref = CASE provider
    WHEN 'notion_work'  THEN 'NOTION_API_KEY'
    WHEN 'notion_personal' THEN 'NOTION_API_KEY'
    WHEN 'google_drive'    THEN 'GOOGLE_REFRESH_TOKEN'
    WHEN 'dex'             THEN 'DEX_API_KEY'
    ELSE credential_ref
  END;

COMMENT ON COLUMN public.user_integrations.routing IS
  'ADR-032 sourcing: native | composio | mcp | own_substrate. Which upstream a send-tool dispatches to behind our gateway port.';
COMMENT ON COLUMN public.user_integrations.credential_ref IS
  'POINTER to the auth, never the secret: env var name (native) or Composio connected-account id (composio).';
COMMENT ON COLUMN public.user_integrations.status IS
  'Connection health (connected | needs_reauth | disconnected | error), distinct from the enabled on/off flag.';
COMMENT ON COLUMN public.user_integrations.expires_at IS
  'When the current credential expires (e.g. LinkedIn/Instagram 60-day tokens). Drives re-consent reminders. NULL = non-expiring.';

-- Migration complete: user_integrations now records per-provider routing + connection health.

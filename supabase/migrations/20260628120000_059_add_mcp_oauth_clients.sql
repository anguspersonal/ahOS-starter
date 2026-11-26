-- Migration 059: persist dynamically-registered OAuth clients for the ahkms MCP server's
-- remote serving surface (ADR-019 follow-up #1 / issue #84).
--
-- Why this table exists: the remote MCP server (packages/mcp-server/src/http.ts) is an
-- OAuth 2.1 Authorization Server. MCP clients (claude.ai web/mobile, Cursor, …) register
-- themselves at runtime via RFC 7591 Dynamic Client Registration. Storing those records in
-- Supabase — rather than in-process memory — is what lets a paired client survive a Railway
-- restart/redeploy without the owner having to re-authenticate. Access/refresh tokens are
-- stateless JWTs and are deliberately NOT stored here.
--
-- Contents are non-secret OAuth client metadata (redirect_uris, client_name, the generated
-- client_id, and for confidential clients a client_secret hash-equivalent string). This
-- follows the same "non-secret IDs live in the DB, secrets live in env" rule as
-- user_integrations. The Supabase service-role key never appears here.

CREATE TABLE IF NOT EXISTS public.mcp_oauth_clients (
  client_id   text PRIMARY KEY,
  -- Full OAuthClientInformationFull record (RFC 7591) as returned to the client on
  -- registration. Kept as a single JSONB blob so the SDK's client store can round-trip it
  -- verbatim without this schema having to track every optional OAuth field.
  client      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mcp_oauth_clients IS
  'Dynamically-registered OAuth clients for the ahkms MCP remote serving surface (issue #84). Non-secret client metadata only; no Supabase/provider credentials, no tokens.';

-- The MCP server reaches this table with the service-role key (RLS bypassed), exactly like
-- the rest of the Phase-0 server. Enable RLS with no policies so that anon/authenticated
-- roles get NO access by default — this is server-plumbing, never client-readable.
ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;

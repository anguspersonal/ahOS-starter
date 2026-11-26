-- Migration 144: Indexes and stats RPC for ledger_query over public.action_ledger
-- Cites ADR-104, ADR-105, and issue #1476.

SET statement_timeout = '15s';

-- 1. Filter indexes for ledger_query (created_at, action_id, and trace_id indexes exist from migrations 132 & 136)
CREATE INDEX IF NOT EXISTS action_ledger_caller_created_at_idx
    ON public.action_ledger (caller, created_at DESC);

CREATE INDEX IF NOT EXISTS action_ledger_client_id_created_at_idx
    ON public.action_ledger (client_id, created_at DESC)
    WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS action_ledger_session_id_created_at_idx
    ON public.action_ledger (session_id, created_at DESC)
    WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS action_ledger_request_id_idx
    ON public.action_ledger (request_id);

CREATE INDEX IF NOT EXISTS action_ledger_parent_request_id_created_at_idx
    ON public.action_ledger (parent_request_id, created_at DESC)
    WHERE parent_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS action_ledger_outcome_created_at_idx
    ON public.action_ledger (outcome, created_at DESC);

-- 2. Stats RPC returning row estimate and total relation bytes for summary mode
DROP FUNCTION IF EXISTS public.action_ledger_stats();

CREATE FUNCTION public.action_ledger_stats()
RETURNS TABLE (
    row_estimate bigint,
    total_bytes bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        GREATEST(COALESCE(c.reltuples::bigint, 0), 0) AS row_estimate,
        pg_total_relation_size('public.action_ledger'::regclass)::bigint AS total_bytes
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'action_ledger';
$$;

REVOKE ALL ON FUNCTION public.action_ledger_stats() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.action_ledger_stats() TO service_role;

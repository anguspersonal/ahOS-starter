-- Migration 132: Create public.action_ledger table (append-only audit log)
-- The table is append-only for every role. Cites ADR-100 §1 and issue #1411.

SET statement_timeout = '15s';

-- 1. Create table public.action_ledger
CREATE TABLE IF NOT EXISTS public.action_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    action_id text NOT NULL,
    seam text NOT NULL,
    caller text NOT NULL,
    request_id text NOT NULL,
    user_id text,
    client_id text,
    session_id text,
    outcome text NOT NULL,
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    error_message text,
    input_keys text[] NOT NULL DEFAULT '{}',
    input_sha256 text,
    CONSTRAINT action_ledger_seam_check CHECK (seam IN ('action', 'legacy_tool')),
    CONSTRAINT action_ledger_outcome_check CHECK (outcome IN ('success', 'error', 'validation_error'))
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS action_ledger_created_at_idx ON public.action_ledger (created_at DESC);
CREATE INDEX IF NOT EXISTS action_ledger_action_id_created_at_idx ON public.action_ledger (action_id, created_at DESC);

-- 3. Row Level Security & permissions (append-only: no policies, service_role insert and select only)
ALTER TABLE public.action_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.action_ledger FROM public, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.action_ledger TO service_role;

-- 4. Refuse change trigger (append-only enforcement)
DROP FUNCTION IF EXISTS public.action_ledger_refuse_change() CASCADE;
CREATE FUNCTION public.action_ledger_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'action_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS action_ledger_refuse_row_change ON public.action_ledger;
CREATE TRIGGER action_ledger_refuse_row_change
    BEFORE UPDATE OR DELETE ON public.action_ledger
    FOR EACH ROW
    EXECUTE FUNCTION public.action_ledger_refuse_change();

DROP TRIGGER IF EXISTS action_ledger_refuse_truncate ON public.action_ledger;
CREATE TRIGGER action_ledger_refuse_truncate
    BEFORE TRUNCATE ON public.action_ledger
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.action_ledger_refuse_change();

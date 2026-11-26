-- Migration 136: Add parent_request_id and trace_id to public.action_ledger
-- Cites ADR-104 §1, ADR-105 L2, and issue #1561.

SET statement_timeout = '15s';

ALTER TABLE public.action_ledger
    ADD COLUMN IF NOT EXISTS parent_request_id text,
    ADD COLUMN IF NOT EXISTS trace_id text;

CREATE INDEX IF NOT EXISTS action_ledger_trace_id_created_at_idx
    ON public.action_ledger (trace_id, created_at)
    WHERE trace_id IS NOT NULL;

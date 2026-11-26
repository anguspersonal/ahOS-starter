-- Migration 152: Add client_local seam to public.action_ledger
-- Cites ADR-105 R9, §5 and issue #1558.

SET statement_timeout = '15s';

ALTER TABLE public.action_ledger
    DROP CONSTRAINT IF EXISTS action_ledger_seam_check;

ALTER TABLE public.action_ledger
    ADD CONSTRAINT action_ledger_seam_check CHECK (seam IN ('action', 'legacy_tool', 'client_local'));

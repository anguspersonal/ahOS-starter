-- Migration 137: Add approval gate outcomes and decision_id to public.action_ledger
-- Cites ADR-100 §1 and issue #1416.

SET statement_timeout = '15s';

ALTER TABLE public.action_ledger
    DROP CONSTRAINT IF EXISTS action_ledger_outcome_check;

ALTER TABLE public.action_ledger
    ADD CONSTRAINT action_ledger_outcome_check CHECK (outcome IN ('success', 'error', 'validation_error', 'denied', 'pending_approval'));

ALTER TABLE public.action_ledger
    ADD COLUMN IF NOT EXISTS decision_id uuid;

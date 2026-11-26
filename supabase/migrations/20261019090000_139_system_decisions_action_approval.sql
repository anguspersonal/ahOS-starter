-- Migration: Add 'executed' and 'failed' statuses and input_sha256 to system_decisions for action_approval
-- Date: 2026-10-19
-- Purpose: Extend system_decisions so parked outward agent action calls (decision_type = 'action_approval')
--          store their canonical input SHA-256 hash and transition through executed/failed statuses.
-- References: ADR-100 §1, ADR-104 (Accepted), issue #1417

SET statement_timeout = '15s';

BEGIN;

-- Step 1: Drop and re-add system_decisions_status_check with ten status values
ALTER TABLE public.system_decisions
  DROP CONSTRAINT IF EXISTS system_decisions_status_check;

ALTER TABLE public.system_decisions
  ADD CONSTRAINT system_decisions_status_check
  CHECK (
    status = ANY (
      ARRAY[
        'pending'::text,
        'auto_applied'::text,
        'approved'::text,
        'rejected'::text,
        'modified'::text,
        'snoozed'::text,
        'expired'::text,
        'dismissed'::text,
        'executed'::text,
        'failed'::text
      ]
    )
  );

-- Step 2: Add nullable input_sha256 column for action_approval hash binding (ADR-104 G4, G10)
ALTER TABLE public.system_decisions
  ADD COLUMN IF NOT EXISTS input_sha256 text;

COMMENT ON COLUMN public.system_decisions.input_sha256 IS
  'Lowercase 64-hex SHA-256 of canonicalJson(input) for action_approval rows (ADR-100 §1, ADR-104, #1417); NULL for other decision_type values.';

-- Step 3: Enforce 64-character lowercase hex SHA-256 on action_approval rows
ALTER TABLE public.system_decisions
  DROP CONSTRAINT IF EXISTS system_decisions_action_approval_hash_check;

ALTER TABLE public.system_decisions
  ADD CONSTRAINT system_decisions_action_approval_hash_check
  CHECK (
    decision_type <> 'action_approval' OR input_sha256 ~ '^[0-9a-f]{64}$'
  );

-- Step 4: Partial index for pending/expiring action_approval lookups
CREATE INDEX IF NOT EXISTS idx_system_decisions_action_approval
  ON public.system_decisions (status, expires_at)
  WHERE decision_type = 'action_approval';

COMMIT;

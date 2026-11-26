-- Migration 143: Hash-chain public.action_ledger rows and add action_ledger_verify(p_since)
-- Cites ADR-105 (#1466), ADR-104, ADR-052 §2, and issue #1493.
-- NOTE: Any later column added to public.action_ledger MUST be nullable with no default,
-- or the hash chain needs a version bump (because jsonb_strip_nulls(to_jsonb(row) - 'prev_hash' - 'row_hash')::text
-- omits nulls and therefore leaves earlier row hashes valid when new nullable columns are added).

SET statement_timeout = '15s';

-- 1. Columns (nullable so rows inserted before this migration keep null hashes)
ALTER TABLE public.action_ledger
    ADD COLUMN IF NOT EXISTS prev_hash text,
    ADD COLUMN IF NOT EXISTS row_hash text;

-- 2. BEFORE INSERT trigger function to compute prev_hash and row_hash under a transaction advisory lock
DROP FUNCTION IF EXISTS public.action_ledger_compute_hash() CASCADE;
CREATE FUNCTION public.action_ledger_compute_hash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
SET timezone = 'UTC'
AS $$
DECLARE
    v_prev_hash text;
    v_prev_created_at timestamptz;
    v_canonical text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('public.action_ledger_chain'));

    SELECT row_hash, created_at
      INTO v_prev_hash, v_prev_created_at
      FROM public.action_ledger
     WHERE row_hash IS NOT NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1;

    IF v_prev_created_at IS NULL THEN
        SELECT MAX(created_at)
          INTO v_prev_created_at
          FROM public.action_ledger;
    END IF;

    IF v_prev_created_at IS NOT NULL AND NEW.created_at <= v_prev_created_at THEN
        NEW.created_at := v_prev_created_at + interval '1 microsecond';
    END IF;

    NEW.prev_hash := v_prev_hash;
    v_canonical := pg_catalog.jsonb_strip_nulls(pg_catalog.to_jsonb(NEW) - 'prev_hash' - 'row_hash')::text;
    NEW.row_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(COALESCE(v_prev_hash, '') || v_canonical, 'UTF8')),
        'hex'
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS action_ledger_chain_before_insert ON public.action_ledger;
CREATE TRIGGER action_ledger_chain_before_insert
    BEFORE INSERT ON public.action_ledger
    FOR EACH ROW
    EXECUTE FUNCTION public.action_ledger_compute_hash();

-- 3. Verification RPC: returns (checked_count, first_broken) for chained rows since p_since
DROP FUNCTION IF EXISTS public.action_ledger_verify(timestamptz);
CREATE FUNCTION public.action_ledger_verify(p_since timestamptz DEFAULT NULL)
RETURNS TABLE (
    checked_count bigint,
    first_broken uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET timezone = 'UTC'
AS $$
DECLARE
    v_row public.action_ledger%ROWTYPE;
    v_chain_start timestamptz;
    v_expected_prev text := NULL;
    v_canonical text;
    v_expected_hash text;
    v_checked bigint := 0;
    v_broken uuid := NULL;
BEGIN
    SELECT MIN(created_at)
      INTO v_chain_start
      FROM public.action_ledger
     WHERE row_hash IS NOT NULL
        OR prev_hash IS NOT NULL;

    IF v_chain_start IS NULL THEN
        RETURN QUERY SELECT 0::bigint, NULL::uuid;
        RETURN;
    END IF;

    IF p_since IS NOT NULL THEN
        SELECT row_hash
          INTO v_expected_prev
          FROM public.action_ledger
         WHERE created_at >= v_chain_start
           AND created_at < p_since
         ORDER BY created_at DESC, id DESC
         LIMIT 1;
    END IF;

    FOR v_row IN
        SELECT *
          FROM public.action_ledger
         WHERE created_at >= v_chain_start
           AND (p_since IS NULL OR created_at >= p_since)
         ORDER BY created_at ASC, id ASC
    LOOP
        v_checked := v_checked + 1;

        IF v_row.row_hash IS NULL THEN
            IF v_broken IS NULL THEN
                v_broken := v_row.id;
            END IF;
        ELSE
            v_canonical := pg_catalog.jsonb_strip_nulls(pg_catalog.to_jsonb(v_row) - 'prev_hash' - 'row_hash')::text;
            v_expected_hash := pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(COALESCE(v_row.prev_hash, '') || v_canonical, 'UTF8')),
                'hex'
            );

            IF v_row.prev_hash IS DISTINCT FROM v_expected_prev OR v_row.row_hash IS DISTINCT FROM v_expected_hash THEN
                IF v_broken IS NULL THEN
                    v_broken := v_row.id;
                END IF;
            END IF;
        END IF;

        v_expected_prev := v_row.row_hash;
    END LOOP;

    RETURN QUERY SELECT v_checked, v_broken;
END;
$$;

REVOKE ALL ON FUNCTION public.action_ledger_verify(timestamptz) FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.action_ledger_verify(timestamptz) TO service_role;

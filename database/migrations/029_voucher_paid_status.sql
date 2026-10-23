-- ============================================
-- VOUCHER PAID STATUS MIGRATION
-- Version: 029
-- Description: Complete the voucher lifecycle for settled redemptions
--              (blink-wip#1665, PR #94):
--              1. Allow the PAID status. Migration 008's constraint predates
--                 it; without the ALTER every CLAIMED -> PAID update fails
--                 with SQLSTATE 23514.
--              2. Settled rows follow the 30-day claimed retention policy
--                 in cleanup_old_vouchers().
--              3. voucher_stats keeps counting PAID as redeemed: the
--                 "claimed" bucket becomes CLAIMED + PAID.
-- Date: 2026-10-22
-- ============================================

-- One transaction: the chart's migration runner (psql -v ON_ERROR_STOP=1)
-- applies files statement by statement, so without it a failure after the
-- DROP CONSTRAINT would leave vouchers with no status constraint while the
-- previous pod keeps serving, and a failure later in the file could still
-- record schema_version 29.
BEGIN;

-- ============================================
-- STATUS CONSTRAINT: allow PAID
-- ============================================
-- MIGRATION-029:STATUS-CONSTRAINT:BEGIN
ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS valid_voucher_status;

ALTER TABLE vouchers
    ADD CONSTRAINT valid_voucher_status
    CHECK (status IN ('ACTIVE', 'CLAIMED', 'CANCELLED', 'EXPIRED', 'PAID'));
-- MIGRATION-029:STATUS-CONSTRAINT:END

-- ============================================
-- CLEANUP FUNCTION: PAID follows the claimed retention policy
-- ============================================
-- Migration 008 only deleted status = 'CLAIMED', so once PAID is reachable
-- settled rows (including api_key_encrypted and voucher metadata) would be
-- retained forever. The original retention expression
-- (30 * 24 * 60 * 60 * 1000) also overflows int4 at invocation with
-- "integer out of range"; the ::BIGINT casts make the arithmetic BIGINT.
-- MIGRATION-029:CLEANUP-FUNCTION:BEGIN
CREATE OR REPLACE FUNCTION cleanup_old_vouchers()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER := 0;
    tmp_count INTEGER;
    now_ms BIGINT;
    claimed_retention_ms BIGINT := 30::BIGINT * 24 * 60 * 60 * 1000;    -- 30 days
    cancelled_retention_ms BIGINT := 30::BIGINT * 24 * 60 * 60 * 1000;  -- 30 days
    expired_retention_ms BIGINT := 7::BIGINT * 24 * 60 * 60 * 1000;     -- 7 days
BEGIN
    now_ms := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;

    -- Delete old claimed/settled vouchers (both were redeemed)
    DELETE FROM vouchers
    WHERE status IN ('CLAIMED', 'PAID')
      AND claimed_at IS NOT NULL
      AND (now_ms - claimed_at) > claimed_retention_ms;

    GET DIAGNOSTICS tmp_count = ROW_COUNT;
    deleted_count := deleted_count + tmp_count;

    -- Delete old cancelled vouchers
    DELETE FROM vouchers
    WHERE status = 'CANCELLED'
      AND cancelled_at IS NOT NULL
      AND (now_ms - cancelled_at) > cancelled_retention_ms;

    GET DIAGNOSTICS tmp_count = ROW_COUNT;
    deleted_count := deleted_count + tmp_count;

    -- Delete old expired vouchers
    DELETE FROM vouchers
    WHERE status = 'EXPIRED'
      AND expires_at IS NOT NULL
      AND (now_ms - expires_at) > expired_retention_ms;

    GET DIAGNOSTICS tmp_count = ROW_COUNT;
    deleted_count := deleted_count + tmp_count;

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
-- MIGRATION-029:CLEANUP-FUNCTION:END

-- ============================================
-- VIEW: Voucher statistics
-- ============================================
CREATE OR REPLACE VIEW voucher_stats AS
SELECT
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE status = 'ACTIVE') as active,
    COUNT(*) FILTER (WHERE status IN ('CLAIMED', 'PAID')) as claimed,
    COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled,
    COUNT(*) FILTER (WHERE status = 'EXPIRED') as expired,
    COUNT(*) FILTER (
        WHERE status = 'ACTIVE'
        AND expires_at < ((EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT + 24 * 60 * 60 * 1000)
    ) as expiring_soon,
    -- USD voucher stats
    COUNT(*) FILTER (WHERE wallet_currency = 'USD') as total_usd,
    COUNT(*) FILTER (WHERE wallet_currency = 'USD' AND status = 'ACTIVE') as active_usd,
    COUNT(*) FILTER (WHERE wallet_currency = 'BTC') as total_btc,
    COUNT(*) FILTER (WHERE wallet_currency = 'BTC' AND status = 'ACTIVE') as active_btc
FROM vouchers;

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    29,
    'version',
    '{"description": "Voucher CLAIMED -> PAID settlement transition; PAID added to valid_voucher_status and claimed retention; voucher_stats claimed bucket includes PAID", "date": "2026-10-22"}'
);

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Migration 029 completed: PAID status allowed, retained under claimed policy, counted in voucher_stats';
END $$;

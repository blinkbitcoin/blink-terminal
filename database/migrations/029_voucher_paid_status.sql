-- ============================================
-- VOUCHER PAID STATUS MIGRATION
-- Version: 029
-- Description: Voucher redemptions now transition CLAIMED -> PAID when the
--              payment settles (blink-wip#1665, PR #94). Settled vouchers must
--              leave the ACTIVE/CLAIMED liability aggregate (Blink has already
--              debited the wallet), while voucher_stats must keep counting
--              them as redeemed: the "claimed" bucket becomes CLAIMED + PAID.
-- Date: 2026-10-22
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
    '{"description": "Voucher CLAIMED -> PAID settlement transition; voucher_stats claimed bucket includes PAID", "date": "2026-10-22"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 029 completed: voucher_stats counts CLAIMED + PAID as claimed';
END $$;

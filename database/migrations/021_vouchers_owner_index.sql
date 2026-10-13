-- ============================================
-- VOUCHERS OWNER INDEX MIGRATION
-- Version: 021
-- Description: Index for the owner-scoped voucher listing
--              (VoucherStore.getVouchersByWalletIds / getVoucherStatsByWalletIds):
--                WHERE COALESCE(environment, 'production') = $env
--                  AND wallet_id = ANY($walletIds)
--                ORDER BY created_at DESC
-- Date: 2026-10-14
-- ============================================

CREATE INDEX IF NOT EXISTS idx_vouchers_env_wallet_created
ON vouchers ((COALESCE(environment, 'production')), wallet_id, created_at DESC);

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    21,
    'version',
    '{"description": "Add owner-scoped listing index on vouchers", "date": "2026-10-14"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 021 completed: idx_vouchers_env_wallet_created';
END $$;

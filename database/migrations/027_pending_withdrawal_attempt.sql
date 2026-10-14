-- ============================================
-- PENDING WITHDRAWALS: ATTEMPT GENERATION
-- Version: 027
-- Description: boltcard_pending_withdrawals.attempt identifies one try of a
--   payment hash. A failed hash can be re-claimed, which increments attempt.
--   Reconciliation must match the attempt it read, so a delayed result for
--   an older try cannot resolve or restore a newer one.
--   Constant default: existing rows are attempt 1. No table rewrite, no
--   pre-deploy data check.
-- Date: 2026-10-15
-- ============================================

ALTER TABLE boltcard_pending_withdrawals
ADD COLUMN IF NOT EXISTS attempt BIGINT NOT NULL DEFAULT 1;

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    27,
    'version',
    '{"description": "Pending withdrawals: attempt generation", "date": "2026-10-15"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 027 completed: pending withdrawal attempt generation';
END $$;

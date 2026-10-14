-- ============================================
-- PENDING WITHDRAWALS: DAILY WINDOW + KIND
-- Version: 026
-- Description: boltcard_pending_withdrawals gains:
--   - daily_window_reset_at: the card's daily_reset_at at deduction time, so a
--     restore after a daily reset refunds the balance without erasing the NEW
--     window's spending (daily_spent is only adjusted in the same window).
--   - kind: PENDING (payment in flight) | UNKNOWN (outcome unknown) |
--     RESTORE_FAILED (payment definitely not sent, but the local rollback
--     failed). Reconciliation treats RESTORE_FAILED rows differently: with no
--     send transaction for the hash, restoring is safe.
-- Date: 2026-10-14
-- ============================================

ALTER TABLE boltcard_pending_withdrawals
ADD COLUMN IF NOT EXISTS daily_window_reset_at BIGINT;

ALTER TABLE boltcard_pending_withdrawals
ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'PENDING';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM boltcard_pending_withdrawals WHERE kind IS NULL) THEN
        RAISE EXCEPTION 'Migration 026: null kind values are not allowed';
    END IF;
END $$;

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    26,
    'version',
    '{"description": "Pending withdrawals: daily window at deduction + kind", "date": "2026-10-14"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 026 completed: pending withdrawals window + kind';
END $$;

-- ============================================
-- PENDING WITHDRAWALS: FAIR RECONCILIATION ORDER
-- Version: 031
-- Description: The reconcile scheduler (blink-wip#1619) examines at most a
--   batch of unresolved withdrawals per pass. Ordered by created_at alone, a
--   prefix of rows that stay in flight (PENDING / UNKNOWN at Blink) would be
--   re-selected every pass and every later row — even one already PAID or
--   terminally failed — would never be examined. last_checked_at records when
--   a pass last looked at a row; selection orders never-checked rows first,
--   then least recently checked, so every unresolved row gets its turn.
-- Date: 2026-10-23
-- ============================================

BEGIN;

ALTER TABLE boltcard_pending_withdrawals
ADD COLUMN IF NOT EXISTS last_checked_at BIGINT;

-- Selection order of the reconcile pass, over unresolved rows only.
CREATE INDEX IF NOT EXISTS idx_boltcard_pending_withdrawals_check_order
ON boltcard_pending_withdrawals (last_checked_at ASC NULLS FIRST, created_at ASC)
WHERE resolved_at IS NULL;

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    31,
    'version',
    '{"description": "boltcard_pending_withdrawals.last_checked_at for fair batched reconciliation", "date": "2026-10-23"}'
);

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Migration 031 completed: last_checked_at on boltcard_pending_withdrawals';
END $$;

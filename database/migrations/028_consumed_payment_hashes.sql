-- ============================================
-- CONSUMED PAYMENT HASHES
-- Version: 028
-- Description: A payment hash that has been claimed stays consumed even if
--   the card row is deleted. boltcard_pending_withdrawals.card_id cascades
--   on wipe/re-registration, which would otherwise drop the hash and let a
--   replacement card claim the same invoice again.
--   Backfill is insert-only. No pre-deploy data check.
-- Date: 2026-10-15
-- ============================================

CREATE TABLE IF NOT EXISTS boltcard_consumed_payment_hashes (
    payment_hash VARCHAR(64) PRIMARY KEY,
    consumed_at BIGINT NOT NULL
);

INSERT INTO boltcard_consumed_payment_hashes (payment_hash, consumed_at)
SELECT payment_hash, created_at
FROM boltcard_pending_withdrawals
ON CONFLICT (payment_hash) DO NOTHING;

CREATE OR REPLACE FUNCTION retain_consumed_payment_hash()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO boltcard_consumed_payment_hashes (payment_hash, consumed_at)
    VALUES (NEW.payment_hash, NEW.created_at)
    ON CONFLICT (payment_hash) DO NOTHING;

    -- Already consumed, and the withdrawal row is gone (wiped card): reject.
    -- An idempotent replay still has the withdrawal row, so it is allowed
    -- through to ON CONFLICT DO NOTHING on that table.
    IF NOT FOUND AND NOT EXISTS (
        SELECT 1
        FROM boltcard_pending_withdrawals
        WHERE payment_hash = NEW.payment_hash
    ) THEN
        RAISE EXCEPTION 'payment hash already consumed';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_boltcard_pending_withdrawals_retain_hash
ON boltcard_pending_withdrawals;

CREATE TRIGGER trg_boltcard_pending_withdrawals_retain_hash
BEFORE INSERT ON boltcard_pending_withdrawals
FOR EACH ROW
EXECUTE FUNCTION retain_consumed_payment_hash();

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    28,
    'version',
    '{"description": "Consumed payment hashes survive card deletion", "date": "2026-10-15"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 028 completed: consumed payment hashes';
END $$;

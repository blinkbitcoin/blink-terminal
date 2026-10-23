-- ============================================
-- CONSUMED PAYMENT HASH: DEDICATED SQLSTATE
-- Version: 030
-- Description: retain_consumed_payment_hash() (migration 028) rejects an
--   insert into boltcard_pending_withdrawals whose hash is already consumed
--   while the withdrawal row is gone (wiped / re-registered card). It raised a
--   generic exception, so claimAndDeductWithdrawal() could not tell it from a
--   real database fault and the LNURL-withdraw callback answered
--   "Internal server error" after the tap's k1 was already consumed
--   (blink-wip#1646). The same logic now raises SQLSTATE 'BC409', which the
--   store maps to { status: "spent" } — the same "This invoice was already
--   used" answer as the pre-check — without burning the distinction between
--   "already used" and a server fault. Nothing is deducted either way.
-- Date: 2026-10-23
-- ============================================

BEGIN;

-- MIGRATION-030:RETAIN-FUNCTION:BEGIN
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
        RAISE EXCEPTION 'payment hash already consumed'
            USING ERRCODE = 'BC409';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- MIGRATION-030:RETAIN-FUNCTION:END

-- The trigger from 028 keeps pointing at this function (CREATE OR REPLACE
-- preserves the OID); re-created defensively for databases that never ran 028.
DROP TRIGGER IF EXISTS trg_boltcard_pending_withdrawals_retain_hash
ON boltcard_pending_withdrawals;

CREATE TRIGGER trg_boltcard_pending_withdrawals_retain_hash
BEFORE INSERT ON boltcard_pending_withdrawals
FOR EACH ROW
EXECUTE FUNCTION retain_consumed_payment_hash();

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    30,
    'version',
    '{"description": "Consumed payment hash rejection raises SQLSTATE BC409 so the callback answers spent, not 500", "date": "2026-10-23"}'
);

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Migration 030 completed: consumed-hash rejection uses SQLSTATE BC409';
END $$;

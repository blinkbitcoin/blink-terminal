-- ============================================
-- CREDITED TOP-UP HASHES
-- Version: 032
-- Description: A Lightning payment credits a Bolt Card at most once, enforced
--   by the database (blink-wip#1623, defense in depth).
--
--   Until now the only guard was the pending row's processed flag
--   (boltcard_pending_topups): storePendingTopUp's upsert could reset it to
--   FALSE, cleanup deletes processed rows after 24 h, and the TOPUP audit rows
--   in boltcard_transactions cascade away when a card is wiped. Nothing in the
--   schema stopped a second TOPUP credit for the same payment hash.
--
--   boltcard_credited_topups keeps every credited payment hash forever (no
--   foreign key, never cleaned up, like boltcard_consumed_payment_hashes in
--   028). topUpCard inserts into it in the same statement as the balance
--   update, so a second credit for a hash fails the primary key and the whole
--   statement — balance and audit row included — rolls back.
--
--   Backfill is insert-only (ON CONFLICT DO NOTHING): existing duplicate
--   TOPUP rows (possible from the pre-fix race in #1623) cannot fail this
--   migration — the init container would otherwise block the deploy. They
--   are reported with RAISE WARNING for investigation.
-- Date: 2026-10-24
-- ============================================

BEGIN;

CREATE TABLE IF NOT EXISTS boltcard_credited_topups (
    payment_hash VARCHAR(64) PRIMARY KEY,
    card_id VARCHAR(32) NOT NULL,
    credited_at BIGINT NOT NULL
);

DO $$
DECLARE
    dup_count INTEGER;
    dup_sample TEXT;
BEGIN
    SELECT COUNT(*), string_agg(payment_hash || ' x' || n, ', ')
    INTO dup_count, dup_sample
    FROM (
        SELECT payment_hash, COUNT(*) AS n
        FROM boltcard_transactions
        WHERE tx_type = 'TOPUP' AND payment_hash IS NOT NULL
        GROUP BY payment_hash
        HAVING COUNT(*) > 1
        ORDER BY payment_hash
        LIMIT 50
    ) d;
    IF dup_count > 0 THEN
        RAISE WARNING 'Migration 032: % payment hash(es) were credited more than once before this migration (first 50): %',
            dup_count, dup_sample;
    END IF;
END $$;

-- Earliest credit per hash.
INSERT INTO boltcard_credited_topups (payment_hash, card_id, credited_at)
SELECT DISTINCT ON (payment_hash) payment_hash, card_id, created_at
FROM boltcard_transactions
WHERE tx_type = 'TOPUP' AND payment_hash IS NOT NULL
ORDER BY payment_hash, created_at, id
ON CONFLICT (payment_hash) DO NOTHING;

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    32,
    'version',
    '{"description": "boltcard_credited_topups: a payment hash credits a card at most once", "date": "2026-10-24"}'
);

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Migration 032 completed: credited top-up hashes';
END $$;

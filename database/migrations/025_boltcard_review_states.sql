-- ============================================
-- BOLTCARD REVIEW STATES
-- Version: 025
-- Description: Machine-readable states for operations that were claimed but
--              could not complete automatically and need review/reconciliation:
--
--              1. boltcard_pending_withdrawals: LNURL-withdraw payments that
--                 returned PENDING or had an unknown outcome. Keyed by payment
--                 hash; reconciliation resolves them to SUCCESS or restores the
--                 card deduction on terminal failure.
--              2. boltcard_pending_topups.needs_review / review_reason:
--                 claimed top-ups whose transfer/credit outcome is unresolved.
--                 They are EXCLUDED from cleanup_boltcard_pending_topups() so
--                 they survive until an operator resolves them (previously
--                 processed rows were deleted after 24h, hiding the wedge).
-- Date: 2026-10-14
-- ============================================

CREATE TABLE IF NOT EXISTS boltcard_pending_withdrawals (
    payment_hash VARCHAR(64) PRIMARY KEY,
    card_id VARCHAR(32) NOT NULL REFERENCES boltcards(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK (amount > 0),
    balance_after BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    resolved_at BIGINT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('SUCCESS', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_boltcard_pending_withdrawals_card
ON boltcard_pending_withdrawals(card_id);

CREATE INDEX IF NOT EXISTS idx_boltcard_pending_withdrawals_unresolved
ON boltcard_pending_withdrawals(resolved_at)
WHERE resolved_at IS NULL;

ALTER TABLE boltcard_pending_topups
ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boltcard_pending_topups
ADD COLUMN IF NOT EXISTS review_reason TEXT;

CREATE OR REPLACE FUNCTION cleanup_boltcard_pending_topups()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
    now_ms BIGINT;
BEGIN
    now_ms := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;

    -- Delete expired unprocessed top-ups (older than 1 hour after expiry) and
    -- processed top-ups (older than 24 hours) - EXCEPT rows flagged for review,
    -- which survive until an operator resolves them.
    DELETE FROM boltcard_pending_topups
    WHERE NOT needs_review
      AND (
        (processed = FALSE AND expires_at < now_ms - 3600000)
        OR (processed = TRUE AND processed_at < now_ms - 86400000)
      );

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    25,
    'version',
    '{"description": "Bolt Card review states: pending withdrawals queue, top-up review flags", "date": "2026-10-14"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 025 completed: boltcard review states';
END $$;

-- ============================================
-- BOLTCARD WITHDRAW SESSIONS
-- Version: 024
-- Description: Single-use LNURL-withdraw k1, bound to one verified card tap.
--
--              A tap (GET /api/boltcard/lnurlw/[cardId]?p=..&c=..) with a valid
--              SUN/CMAC and a NEWER counter atomically advances
--              boltcards.last_counter and creates one session holding
--              sha256(k1), the card, the tap counter, the tap-time maximum
--              (msats) and a short expiry. The callback must present that k1;
--              it is consumed atomically (used_at), so one tap pays at most one
--              invoice. The cardId is never an authorizer.
-- Date: 2026-10-14
-- ============================================

CREATE TABLE IF NOT EXISTS boltcard_withdraw_sessions (
    k1_hash VARCHAR(64) PRIMARY KEY,          -- sha256(k1) hex; raw k1 is never stored
    card_id VARCHAR(32) NOT NULL REFERENCES boltcards(id) ON DELETE CASCADE,
    counter INTEGER NOT NULL,                 -- SUN counter of the tap that created it
    max_msats BIGINT NOT NULL CHECK (max_msats > 0),
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT                            -- set when the callback consumed it
);

CREATE INDEX IF NOT EXISTS idx_boltcard_withdraw_sessions_card
ON boltcard_withdraw_sessions(card_id);

CREATE INDEX IF NOT EXISTS idx_boltcard_withdraw_sessions_expires
ON boltcard_withdraw_sessions(expires_at);

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    24,
    'version',
    '{"description": "Add boltcard_withdraw_sessions (single-use tap-bound k1)", "date": "2026-10-14"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 024 completed: boltcard_withdraw_sessions';
END $$;

-- ============================================
-- PAYMENT SPLITS MIGRATION
-- Version: 019
-- Description: Add payment_splits and payment_events tables
--              plus active_payments monitoring view.
--              These tables back the hybrid Redis/PostgreSQL
--              storage layer (lib/storage/hybrid-store.ts) and
--              are required for authenticated POS invoice creation.
-- Date: 2026-05-19
-- ============================================

-- ============================================
-- PAYMENT SPLITS TABLE
-- Main table for all payment split records.
-- Every Lightning invoice created through the authenticated POS
-- gets a row here. Redis acts as a hot cache in front of this table.
-- ============================================

CREATE TABLE IF NOT EXISTS payment_splits (
    id                  BIGSERIAL       PRIMARY KEY,

    -- Unique Lightning invoice identifier (64-char hex hash)
    payment_hash        VARCHAR(64)     NOT NULL,

    -- User identification (SHA-256 hash of the API key, never the key itself)
    user_api_key_hash   VARCHAR(64)     NOT NULL,

    -- Blink wallet ID that received the payment (or "NWC_ONLY_USER" placeholder)
    user_wallet_id      VARCHAR(100)    NOT NULL,

    -- Amounts in satoshis
    total_amount        BIGINT          NOT NULL,
    base_amount         BIGINT          NOT NULL,
    tip_amount          BIGINT          NOT NULL,
    tip_percent         DECIMAL(5,2)    NOT NULL DEFAULT 0,

    -- Tip forwarding destination (legacy single-recipient field)
    tip_recipient       VARCHAR(100),

    -- Display formatting
    display_currency    VARCHAR(10)     NOT NULL DEFAULT 'BTC',
    base_amount_display VARCHAR(50),
    tip_amount_display  VARCHAR(50),

    -- Invoice memo (max ~640 chars enforced at API layer)
    memo                TEXT,

    -- Lifecycle status: pending -> processing -> completed | failed | expired
    status              VARCHAR(20)     NOT NULL DEFAULT 'pending',

    -- Flexible JSONB for forwarding config, NWC URIs, environment, etc.
    metadata            JSONB,

    -- Timestamps
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMP       NOT NULL,
    processed_at        TIMESTAMP
);

-- Primary lookup path: every read/update uses payment_hash
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_splits_hash
    ON payment_splits (payment_hash);

-- Status filtering (stats aggregation, expiry cleanup)
CREATE INDEX IF NOT EXISTS idx_payment_splits_status
    ON payment_splits (status);

-- Time-range queries (24h stats window)
CREATE INDEX IF NOT EXISTS idx_payment_splits_created
    ON payment_splits (created_at DESC);

-- Expiry cleanup job (runs every 5 minutes)
CREATE INDEX IF NOT EXISTS idx_payment_splits_expires
    ON payment_splits (expires_at)
    WHERE status IN ('pending', 'processing');

-- Per-user transaction lookups
CREATE INDEX IF NOT EXISTS idx_payment_splits_wallet
    ON payment_splits (user_wallet_id);

-- Tip recipient lookups
CREATE INDEX IF NOT EXISTS idx_payment_splits_recipient
    ON payment_splits (tip_recipient)
    WHERE tip_recipient IS NOT NULL;

-- ============================================
-- PAYMENT EVENTS TABLE
-- Audit trail for all payment state changes.
-- Logging failures are swallowed (never break the main flow).
-- ============================================

CREATE TABLE IF NOT EXISTS payment_events (
    id              BIGSERIAL       PRIMARY KEY,

    -- Links to payment_splits (no FK constraint: logging must not
    -- fail if the parent INSERT itself failed)
    payment_hash    VARCHAR(64)     NOT NULL,

    -- Event classification
    -- Types: created, claimed_for_processing, claim_released, status_*
    event_type      VARCHAR(50)     NOT NULL,

    -- Outcome: success, failure
    event_status    VARCHAR(20)     NOT NULL,

    -- Optional structured data
    metadata        JSONB,

    -- Error details (only on failure events)
    error_message   TEXT,

    created_at      TIMESTAMP       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_hash
    ON payment_events (payment_hash);

CREATE INDEX IF NOT EXISTS idx_payment_events_created
    ON payment_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_events_type
    ON payment_events (event_type);

-- ============================================
-- ACTIVE PAYMENTS VIEW
-- Convenience view for monitoring non-terminal payments.
-- Used by getActivePayments() in hybrid-store.ts.
-- ============================================

CREATE OR REPLACE VIEW active_payments AS
SELECT
    id,
    payment_hash,
    user_api_key_hash,
    user_wallet_id,
    total_amount,
    base_amount,
    tip_amount,
    tip_percent,
    tip_recipient,
    display_currency,
    base_amount_display,
    tip_amount_display,
    memo,
    status,
    metadata,
    created_at,
    expires_at,
    processed_at
FROM payment_splits
WHERE status IN ('pending', 'processing')
  AND expires_at >= NOW();

-- ============================================
-- SCHEMA VERSION UPDATE
-- ============================================

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    19,
    'version',
    '{"description": "Payment splits, events, and active payments view", "date": "2026-05-19"}'
);

-- ============================================
-- COMPLETION
-- ============================================
DO $$
BEGIN
    RAISE NOTICE 'Migration 019: payment_splits, payment_events, active_payments created';
END $$;

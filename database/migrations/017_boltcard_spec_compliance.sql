-- ============================================
-- BOLTCARD SPEC COMPLIANCE MIGRATION
-- Version: 017
-- Description: Add spec-compliant key derivation and privacy-preserving fields
-- Date: 2026-02-08
-- 
-- This migration updates the boltcard schema to be compliant with:
-- - https://github.com/boltcard/boltcard/blob/main/docs/DETERMINISTIC.md
-- - https://github.com/boltcard/boltcard/blob/main/docs/DEEPLINK.md
-- ============================================

-- ============================================
-- ISSUER KEYS TABLE
-- Stores per-user IssuerKey for deterministic key derivation
-- One key per user, used to derive all card keys
-- ============================================

CREATE TABLE IF NOT EXISTS boltcard_issuer_keys (
    -- Owner identification (Nostr pubkey)
    owner_pubkey VARCHAR(64) PRIMARY KEY,
    
    -- Encrypted IssuerKey (16 bytes / 32 hex chars when decrypted)
    -- Used to derive K1 (shared encryption key) and CardKey (per-card)
    issuer_key_encrypted TEXT NOT NULL,
    
    -- Timestamp when key was created
    created_at BIGINT NOT NULL,
    
    -- Timestamp when key was last used (for key rotation tracking)
    last_used_at BIGINT
);

-- ============================================
-- ADD NEW COLUMNS TO BOLTCARDS TABLE
-- ============================================

-- Privacy-preserving card ID hash
-- Derived as: ID = PRF(IssuerKey, '2d003f7b' || UID)
-- This allows card lookup without exposing the raw UID
ALTER TABLE boltcards 
ADD COLUMN IF NOT EXISTS card_id_hash VARCHAR(32);

-- Create index for efficient card lookup by ID hash
CREATE INDEX IF NOT EXISTS idx_boltcards_card_id_hash 
ON boltcards(card_id_hash);

-- ============================================
-- BOLTCARD PENDING REGISTRATIONS TABLE
-- Stores pending card registrations before UID is known
-- Used with the deeplink flow where card is scanned after registration starts
-- ============================================

CREATE TABLE IF NOT EXISTS boltcard_pending_registrations (
    -- Registration ID (shown in QR code)
    id VARCHAR(32) PRIMARY KEY,
    
    -- Owner who initiated the registration
    owner_pubkey VARCHAR(64) NOT NULL,
    
    -- Wallet configuration (pre-configured)
    wallet_id VARCHAR(128) NOT NULL,
    wallet_currency VARCHAR(10) NOT NULL DEFAULT 'BTC',
    api_key_encrypted TEXT NOT NULL,
    
    -- Card settings (pre-configured)
    name VARCHAR(100),
    max_tx_amount BIGINT,
    daily_limit BIGINT,
    initial_balance BIGINT NOT NULL DEFAULT 0,
    
    -- Environment
    environment VARCHAR(20) NOT NULL DEFAULT 'production',
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    
    -- Timestamps
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,  -- Registration expires after this time
    completed_at BIGINT,         -- When card was programmed
    
    -- If registration was completed, link to the created card
    card_id VARCHAR(32) REFERENCES boltcards(id),
    
    -- Constraints
    CONSTRAINT valid_pending_status CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
    CONSTRAINT valid_pending_currency CHECK (wallet_currency IN ('BTC', 'USD'))
);

-- Index for finding pending registrations by owner
CREATE INDEX IF NOT EXISTS idx_pending_registrations_owner 
ON boltcard_pending_registrations(owner_pubkey, status);

-- Index for cleanup of expired registrations
CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires 
ON boltcard_pending_registrations(expires_at) 
WHERE status = 'PENDING';

-- ============================================
-- HELPER FUNCTION: Cleanup expired pending registrations
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_expired_boltcard_registrations()
RETURNS INTEGER AS $$
DECLARE
    updated_count INTEGER;
    now_ms BIGINT;
BEGIN
    now_ms := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
    
    UPDATE boltcard_pending_registrations
    SET status = 'EXPIRED'
    WHERE status = 'PENDING'
      AND expires_at < now_ms;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- UPDATE BOLTCARD STATS VIEW
-- Include issuer key and pending registration counts
-- ============================================

CREATE OR REPLACE VIEW boltcard_stats AS
SELECT 
    -- Card counts
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE status = 'PENDING') as pending,
    COUNT(*) FILTER (WHERE status = 'ACTIVE') as active,
    COUNT(*) FILTER (WHERE status = 'DISABLED') as disabled,
    COUNT(*) FILTER (WHERE status = 'WIPED') as wiped,
    COUNT(*) FILTER (WHERE wallet_currency = 'BTC') as btc_cards,
    COUNT(*) FILTER (WHERE wallet_currency = 'USD') as usd_cards,
    COALESCE(SUM(balance) FILTER (WHERE wallet_currency = 'BTC' AND status = 'ACTIVE'), 0) as total_btc_balance_sats,
    COALESCE(SUM(balance) FILTER (WHERE wallet_currency = 'USD' AND status = 'ACTIVE'), 0) as total_usd_balance_cents,
    -- Issuer key count (from subquery)
    (SELECT COUNT(*) FROM boltcard_issuer_keys) as issuer_keys,
    -- Pending registration count (from subquery)
    (SELECT COUNT(*) FROM boltcard_pending_registrations WHERE status = 'PENDING') as pending_registrations
FROM boltcards;

-- ============================================
-- DATA MIGRATION: Backfill card_id_hash
-- Note: This requires the application to backfill the hashes
-- since we need the IssuerKey to derive them.
-- Cards without card_id_hash will be handled by the application
-- on first access (lazy migration).
-- ============================================

-- For now, we add a comment explaining the migration strategy
COMMENT ON COLUMN boltcards.card_id_hash IS
'Privacy-preserving ID derived from IssuerKey and UID. Derived as: PRF(IssuerKey, 0x2d003f7b || UID). Cards without this value will be lazily migrated on access.';

-- ============================================
-- SCHEMA VERSION UPDATE
-- ============================================

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version', 
    17, 
    'version', 
    '{"description": "Boltcard spec compliance - issuer keys and privacy fields", "date": "2026-02-08"}'
);

-- ============================================
-- COMPLETION NOTICE
-- ============================================

DO $$
BEGIN
    RAISE NOTICE 'Migration 017 completed: Boltcard spec compliance';
    RAISE NOTICE 'New tables: boltcard_issuer_keys, boltcard_pending_registrations';
    RAISE NOTICE 'New columns: boltcards.card_id_hash';
    RAISE NOTICE 'New functions: cleanup_expired_boltcard_registrations()';
    RAISE NOTICE 'Updated views: boltcard_stats';
    RAISE NOTICE '';
    RAISE NOTICE 'IMPORTANT: Existing cards will need card_id_hash backfilled by application';
    RAISE NOTICE 'The application will handle lazy migration on card access';
END $$;

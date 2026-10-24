-- ============================================
-- USER RECORDS TABLE MIGRATION
-- Version: 020
-- Description: Move per-user data (profiles, wallets, voucher/sending
--              wallet, split profiles, preferences, cart, legacy API-key
--              records and Nostr link records) from per-pod local-disk JSON
--              (.data/user_<hash>.json) into PostgreSQL so it is shared across
--              all application replicas. Fixes cross-device config divergence
--              where each pod held its own copy of a user's wallets.
-- Date: 2026-06-05
-- ============================================

-- ============================================
-- USER RECORDS TABLE
-- Generic key/value store keyed by sha256(userId).
--
-- userId is the same opaque identifier StorageManager has always used:
--   - "nostr:<pubkey>"  -> authenticated POS profile/config blob
--   - "nostr_<pubkey>"  -> Nostr -> legacy account link record
--   - "<legacyUsername>" -> legacy account record (encrypted apiKey, etc.)
--
-- The full 64-hex SHA-256 is used as the primary key (matching the
-- collision-safe hashing in lib/storage.ts). The opaque blob is stored as
-- JSONB; sensitive fields (e.g. apiKey, NWC URIs) are encrypted by the
-- application before they ever reach this table.
-- ============================================

CREATE TABLE IF NOT EXISTS user_records (
    -- sha256(userId) as 64-char lowercase hex
    user_hash VARCHAR(64) PRIMARY KEY,

    -- Opaque per-user data blob (sensitive fields pre-encrypted by the app)
    data JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Bookkeeping
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

-- Most-recently-updated lookups (admin / listUsers ordering)
CREATE INDEX IF NOT EXISTS idx_user_records_updated
ON user_records(updated_at DESC);

-- ============================================
-- SCHEMA VERSION UPDATE
-- ============================================

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    20,
    'version',
    '{"description": "Add user_records table for cross-device user data", "date": "2026-06-05"}'
);

-- ============================================
-- COMPLETION NOTICE
-- ============================================

DO $$
BEGIN
    RAISE NOTICE 'Migration 020 completed: user_records table created';
    RAISE NOTICE 'Tables: user_records';
END $$;

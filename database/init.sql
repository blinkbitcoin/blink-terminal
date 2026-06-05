-- ============================================
-- BlinkPOS Database Initialization
-- Description: Initial schema setup for PostgreSQL container
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- SYSTEM METRICS TABLE
-- Tracks schema versions and system-level metrics
-- ============================================
CREATE TABLE IF NOT EXISTS system_metrics (
    id BIGSERIAL PRIMARY KEY,
    metric_name VARCHAR(255) NOT NULL,
    metric_value DECIMAL(20, 4),
    metric_unit VARCHAR(50),
    tags JSONB,
    recorded_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_metrics_name ON system_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_system_metrics_recorded ON system_metrics(recorded_at DESC);

-- Record initial schema version
INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version', 
    1, 
    'version', 
    '{"description": "Initial schema setup", "date": "2025-01-14"}'
);

-- ============================================
-- USER RECORDS TABLE
-- Generic per-user key/value store keyed by sha256(userId). Holds POS
-- profiles/wallets, voucher (sending) wallet, split profiles, preferences,
-- cart, and legacy API-key / Nostr-link records. Shared across all replicas
-- so user config does not diverge per pod. See migration 020 for details.
-- ============================================
CREATE TABLE IF NOT EXISTS user_records (
    user_hash VARCHAR(64) PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_records_updated ON user_records(updated_at DESC);

-- ============================================
-- COMPLETION
-- ============================================
DO $$
BEGIN
    RAISE NOTICE 'BlinkPOS database initialized successfully!';
    RAISE NOTICE 'Extensions enabled: uuid-ossp';
    RAISE NOTICE 'Tables created: system_metrics, user_records';
END $$;

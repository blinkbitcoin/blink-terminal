-- ============================================
-- FIX METRICS OVERFLOW MIGRATION
-- Version: 007
-- Description: Fix numeric overflow in velocity field and improve metrics computation
-- Date: 2026-01-09
-- ============================================

-- Drop dependent view, alter column, recreate view
-- (community_leaderboard from migration 002 selects cm.velocity, which blocks ALTER TYPE)
DROP VIEW IF EXISTS community_leaderboard;

ALTER TABLE community_metrics
ALTER COLUMN velocity TYPE DECIMAL(20, 4);

CREATE OR REPLACE VIEW community_leaderboard AS
SELECT
    c.id,
    c.name,
    c.slug,
    c.country_code,
    c.city,
    c.member_count,
    c.data_sharing_member_count,
    cm.transaction_count,
    cm.transaction_volume_sats,
    cm.velocity,
    cm.tx_count_growth_percent,
    cm.internal_tx_count,
    CASE
        WHEN cm.transaction_count > 0
        THEN (cm.internal_tx_count::DECIMAL / cm.transaction_count * 100)
        ELSE 0
    END as closed_loop_percent,
    cm.period_start,
    cm.period_end
FROM communities c
LEFT JOIN LATERAL (
    SELECT *
    FROM community_metrics
    WHERE community_id = c.id
      AND period_type = 'monthly'
    ORDER BY period_start DESC
    LIMIT 1
) cm ON true
WHERE c.status = 'active'
ORDER BY cm.transaction_volume_sats DESC NULLS LAST;

-- Update the compute_community_metrics function with better overflow handling
CREATE OR REPLACE FUNCTION compute_community_metrics(
    p_community_id UUID,
    p_period_type VARCHAR(20),
    p_period_start DATE,
    p_period_end DATE
)
RETURNS VOID AS $$
DECLARE
    v_prev_period_start DATE;
    v_prev_member_count INTEGER;
    v_prev_tx_count BIGINT;
    v_prev_volume BIGINT;
BEGIN
    -- Calculate previous period for growth comparison
    CASE p_period_type
        WHEN 'daily' THEN v_prev_period_start := p_period_start - INTERVAL '1 day';
        WHEN 'weekly' THEN v_prev_period_start := p_period_start - INTERVAL '7 days';
        WHEN 'monthly' THEN v_prev_period_start := p_period_start - INTERVAL '1 month';
    END CASE;
    
    -- Get previous period stats
    SELECT member_count, transaction_count, transaction_volume_sats
    INTO v_prev_member_count, v_prev_tx_count, v_prev_volume
    FROM community_metrics
    WHERE community_id = p_community_id
      AND period_type = p_period_type
      AND period_start = v_prev_period_start;
    
    -- Insert or update metrics
    INSERT INTO community_metrics (
        community_id,
        period_type,
        period_start,
        period_end,
        member_count,
        data_sharing_member_count,
        new_members,
        transaction_count,
        transaction_volume_sats,
        unique_transactors,
        internal_tx_count,
        internal_volume_sats,
        velocity,
        avg_tx_per_member,
        member_growth_percent,
        tx_count_growth_percent,
        volume_growth_percent,
        computed_at
    )
    SELECT
        p_community_id,
        p_period_type,
        p_period_start,
        p_period_end,
        -- Member counts from community
        c.member_count,
        c.data_sharing_member_count,
        -- New members this period
        (SELECT COUNT(*) FROM community_memberships 
         WHERE community_id = p_community_id 
           AND status = 'approved' 
           AND approved_at >= p_period_start 
           AND approved_at < p_period_end),
        -- Transaction counts
        COALESCE(tx.tx_count, 0),
        COALESCE(tx.volume_sats, 0),
        COALESCE(tx.unique_users, 0),
        -- Internal transactions
        COALESCE(tx.internal_count, 0),
        COALESCE(tx.internal_volume, 0),
        -- Velocity (transactions per BTC in circulation - capped to avoid overflow)
        CASE WHEN tx.volume_sats > 0 
             THEN LEAST(999999999.9999, tx.tx_count::DECIMAL / NULLIF((tx.volume_sats::DECIMAL / 100000000), 0))
             ELSE 0 END,
        -- Avg transactions per member
        CASE WHEN c.data_sharing_member_count > 0 
             THEN COALESCE(tx.tx_count, 0)::DECIMAL / c.data_sharing_member_count
             ELSE 0 END,
        -- Growth percentages
        CASE WHEN v_prev_member_count > 0 
             THEN ((c.member_count - v_prev_member_count)::DECIMAL / v_prev_member_count * 100)
             ELSE 0 END,
        CASE WHEN v_prev_tx_count > 0 
             THEN ((COALESCE(tx.tx_count, 0) - v_prev_tx_count)::DECIMAL / v_prev_tx_count * 100)
             ELSE 0 END,
        CASE WHEN v_prev_volume > 0 
             THEN ((COALESCE(tx.volume_sats, 0) - v_prev_volume)::DECIMAL / v_prev_volume * 100)
             ELSE 0 END,
        NOW()
    FROM communities c
    LEFT JOIN LATERAL (
        SELECT 
            COUNT(*) as tx_count,
            SUM(settlement_amount) as volume_sats,
            COUNT(DISTINCT consent_id) as unique_users,
            COUNT(*) FILTER (WHERE counterparty_in_community = true) as internal_count,
            SUM(settlement_amount) FILTER (WHERE counterparty_in_community = true) as internal_volume
        FROM member_transactions
        WHERE community_id = p_community_id
          AND tx_created_at >= p_period_start
          AND tx_created_at < p_period_end
    ) tx ON true
    WHERE c.id = p_community_id
    ON CONFLICT (community_id, period_type, period_start)
    DO UPDATE SET
        member_count = EXCLUDED.member_count,
        data_sharing_member_count = EXCLUDED.data_sharing_member_count,
        new_members = EXCLUDED.new_members,
        transaction_count = EXCLUDED.transaction_count,
        transaction_volume_sats = EXCLUDED.transaction_volume_sats,
        unique_transactors = EXCLUDED.unique_transactors,
        internal_tx_count = EXCLUDED.internal_tx_count,
        internal_volume_sats = EXCLUDED.internal_volume_sats,
        velocity = EXCLUDED.velocity,
        avg_tx_per_member = EXCLUDED.avg_tx_per_member,
        member_growth_percent = EXCLUDED.member_growth_percent,
        tx_count_growth_percent = EXCLUDED.tx_count_growth_percent,
        volume_growth_percent = EXCLUDED.volume_growth_percent,
        computed_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Update schema version
INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version', 
    7, 
    'version', 
    '{"description": "Fix metrics overflow", "date": "2026-01-09"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 007 completed: Fixed metrics overflow';
END $$;

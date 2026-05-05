-- ============================================
-- SEED INITIAL DATA - Super Admin & Pioneer Communities
-- Version: 003
-- Description: Seeds the initial super-admin, whitelisted leaders,
--              and pioneer Bitcoin circular economies
-- Date: 2025-12-31
-- ============================================

-- ============================================
-- SUPER ADMIN TABLE
-- Tracks application super-administrators
-- ============================================
CREATE TABLE IF NOT EXISTS super_admins (
    id BIGSERIAL PRIMARY KEY,
    npub VARCHAR(70) UNIQUE NOT NULL,
    pubkey_hex VARCHAR(64),
    display_name VARCHAR(255),
    added_at TIMESTAMP DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'active',
    
    CONSTRAINT check_superadmin_status CHECK (status IN ('active', 'suspended'))
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_super_admins_npub ON super_admins(npub);

-- ============================================
-- SEED SUPER ADMIN
-- Only super-admin can whitelist new community leaders
-- ============================================
INSERT INTO super_admins (npub, display_name)
VALUES (
    'npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6',
    'Super Admin'
)
ON CONFLICT (npub) DO NOTHING;

-- ============================================
-- SEED WHITELISTED COMMUNITY LEADERS
-- ============================================

-- Bitcoin Ekasi Leader
INSERT INTO community_leader_whitelist (npub, display_name, added_by, reason, status)
VALUES (
    'npub1zkr064avsxmxzaasppamps86ge0npwvft9yu3ymgxmk9umx3xyeq9sk6ec',
    'Bitcoin Ekasi Leader',
    'npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6',
    'Pioneer community leader - Bitcoin Ekasi, South Africa',
    'active'
)
ON CONFLICT (npub) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    reason = EXCLUDED.reason,
    updated_at = NOW();

-- Bitcoin Victoria Falls Leader
INSERT INTO community_leader_whitelist (npub, display_name, added_by, reason, status)
VALUES (
    'npub1xxcyzef28e5qcjncwmn6z2nmwaezs2apxc2v2f7unnvxw3r5edfsactfly',
    'Bitcoin Victoria Falls Leader',
    'npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6',
    'Pioneer community leader - Bitcoin Victoria Falls, Zambia',
    'active'
)
ON CONFLICT (npub) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    reason = EXCLUDED.reason,
    updated_at = NOW();

-- Blink Team Leader
INSERT INTO community_leader_whitelist (npub, display_name, added_by, reason, status)
VALUES (
    'npub13ljnkd633c7maxatymv3y2fqq8vt3qk7j3tt0vytv90eztwgha9qmfcfhw',
    'Blink Team Leader',
    'npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6',
    'Pioneer community leader - Blink Team',
    'active'
)
ON CONFLICT (npub) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    reason = EXCLUDED.reason,
    updated_at = NOW();

-- Super Admin (also leads Test Community below)
INSERT INTO community_leader_whitelist (npub, display_name, added_by, reason, status)
VALUES (
    'npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6',
    'Super Admin',
    'npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6',
    'Self-whitelisted super admin - leads Test Community',
    'active'
)
ON CONFLICT (npub) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    reason = EXCLUDED.reason,
    updated_at = NOW();

-- ============================================
-- SEED PIONEER COMMUNITIES
-- ============================================

-- Bitcoin Ekasi
INSERT INTO communities (
    id, name, slug, description,
    country_code, region, city, latitude, longitude,
    leader_npub, status
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567001',
    'Bitcoin Ekasi',
    'bitcoin-ekasi',
    'South Africa''s pioneering Bitcoin circular economy in Mossel Bay. Demonstrating how Bitcoin can transform township economies through merchant adoption, peer-to-peer transactions, and community education.',
    'ZA',
    'Western Cape',
    'Mossel Bay',
    -34.1849,
    22.1265,
    'npub1zkr064avsxmxzaasppamps86ge0npwvft9yu3ymgxmk9umx3xyeq9sk6ec',
    'active'
)
ON CONFLICT (slug) DO UPDATE SET
    description = EXCLUDED.description,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    updated_at = NOW();

-- Create leader membership for Bitcoin Ekasi
INSERT INTO community_memberships (
    community_id, user_npub, role, status, approved_at
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567001',
    'npub1zkr064avsxmxzaasppamps86ge0npwvft9yu3ymgxmk9umx3xyeq9sk6ec',
    'leader',
    'approved',
    NOW()
)
ON CONFLICT (community_id, user_npub) DO UPDATE SET
    role = 'leader',
    status = 'approved';

-- Bitcoin Victoria Falls
INSERT INTO communities (
    id, name, slug, description,
    country_code, region, city, latitude, longitude,
    leader_npub, status
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567002',
    'Bitcoin Victoria Falls',
    'bitcoin-victoria-falls',
    'Zambia''s Bitcoin circular economy centered around the majestic Victoria Falls. Building a sustainable Bitcoin ecosystem for tourism and local commerce.',
    'ZM',
    'Southern Province',
    'Livingstone',
    -17.9154,
    25.8614,
    'npub1xxcyzef28e5qcjncwmn6z2nmwaezs2apxc2v2f7unnvxw3r5edfsactfly',
    'active'
)
ON CONFLICT (slug) DO UPDATE SET
    description = EXCLUDED.description,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    updated_at = NOW();

-- Create leader membership for Bitcoin Victoria Falls
INSERT INTO community_memberships (
    community_id, user_npub, role, status, approved_at
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567002',
    'npub1xxcyzef28e5qcjncwmn6z2nmwaezs2apxc2v2f7unnvxw3r5edfsactfly',
    'leader',
    'approved',
    NOW()
)
ON CONFLICT (community_id, user_npub) DO UPDATE SET
    role = 'leader',
    status = 'approved';

-- Blink Team
INSERT INTO communities (
    id, name, slug, description,
    country_code, region, city, latitude, longitude,
    leader_npub, status
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567004',
    'Blink Team',
    'blink-team',
    'Supporting everyday bitcoin adoption by example',
    'HN',
    'Cortés',
    'Prospera',
    15.5149,
    -88.0253,
    'npub13ljnkd633c7maxatymv3y2fqq8vt3qk7j3tt0vytv90eztwgha9qmfcfhw',
    'active'
)
ON CONFLICT (slug) DO UPDATE SET
    description = EXCLUDED.description,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    updated_at = NOW();

-- Create leader membership for Blink Team
INSERT INTO community_memberships (
    community_id, user_npub, role, status, approved_at
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567004',
    'npub13ljnkd633c7maxatymv3y2fqq8vt3qk7j3tt0vytv90eztwgha9qmfcfhw',
    'leader',
    'approved',
    NOW()
)
ON CONFLICT (community_id, user_npub) DO UPDATE SET
    role = 'leader',
    status = 'approved';

-- Test Community (Super Admin is leader)
INSERT INTO communities (
    id, name, slug, description,
    country_code, region, city, latitude, longitude,
    leader_npub, status
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567003',
    'Test Community',
    'test-community',
    'A test community for exploring the leader dashboard experience. Use this to test membership approvals, data sharing opt-ins, and community metrics.',
    'XX',
    'Test Region',
    'Test City',
    0,
    0,
    'npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6',
    'active'
)
ON CONFLICT (slug) DO UPDATE SET
    description = EXCLUDED.description,
    updated_at = NOW();

-- Create leader membership for Test Community (Super Admin)
INSERT INTO community_memberships (
    community_id, user_npub, role, status, approved_at
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567003',
    'npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6',
    'leader',
    'approved',
    NOW()
)
ON CONFLICT (community_id, user_npub) DO UPDATE SET
    role = 'leader',
    status = 'approved';

-- ============================================
-- UPDATE SCHEMA VERSION
-- ============================================

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version', 
    3, 
    'version', 
    '{"description": "Seed initial super-admin and pioneer communities", "date": "2025-12-31"}'
);

-- ============================================
-- COMPLETION
-- ============================================

DO $$
BEGIN
    RAISE NOTICE 'Initial data seeded successfully!';
    RAISE NOTICE 'Super Admin: npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6';
    RAISE NOTICE 'Pioneer Communities:';
    RAISE NOTICE '  - Bitcoin Ekasi (South Africa)';
    RAISE NOTICE '  - Bitcoin Victoria Falls (Zambia)';
    RAISE NOTICE '  - Blink Team (Honduras)';
    RAISE NOTICE '  - Test Community (Super Admin is leader)';
END $$;

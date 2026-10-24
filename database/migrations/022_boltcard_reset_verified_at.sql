-- ============================================
-- BOLTCARD RESET VERIFICATION MIGRATION
-- Version: 022
-- Description: Record when a card reset was tap-verified
--              (POST /api/boltcard/reset/[cardId] with a valid SUN tap).
--              POST /api/boltcard/reset/[cardId]/confirm only marks the card
--              WIPED within a short window after such a verification, so a
--              bare cardId can no longer wipe someone else's card.
-- Date: 2026-10-14
-- ============================================

ALTER TABLE boltcards
ADD COLUMN IF NOT EXISTS reset_verified_at BIGINT;

COMMENT ON COLUMN boltcards.reset_verified_at IS
'Epoch ms of the last tap-verified reset request; required (recent) to confirm a wipe';

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    22,
    'version',
    '{"description": "Add boltcards.reset_verified_at for tap-verified reset confirmation", "date": "2026-10-14"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 022 completed: boltcards.reset_verified_at';
END $$;

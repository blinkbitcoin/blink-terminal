-- ============================================
-- BOLTCARD OWNER PUBKEY NORMALIZATION
-- Version: 023
-- Description: Store Bolt Card owner pubkeys lowercase (hex). Owners are now
--              identified by their Nostr session pubkey (lowercase); rows
--              created earlier stored whatever case the client sent, and the
--              owner lookups are case-sensitive.
--
--              All-or-nothing (single transaction). If the same pubkey has
--              more than one case variant in boltcard_issuer_keys (the PRIMARY
--              KEY), the issuer keys cannot be reconciled in SQL (ciphertexts
--              are salted) and picking one could bind cards to the wrong key.
--              The migration then ABORTS before changing anything, listing the
--              affected (public) pubkeys; schema_version stays at 22 and the
--              migration re-runs after remediation.
--
-- Pre-deploy check (must return no rows):
--   SELECT lower(owner_pubkey), count(*) FROM boltcard_issuer_keys
--   GROUP BY 1 HAVING count(*) > 1;
--
-- Remediation if it does: for each card of that owner, re-derive K0 with each
-- candidate issuer key (deriveAllKeys(issuerKey, card_uid, version)) and
-- compare with the card's stored K0 to find which key the cards use; keep that
-- row, delete the other(s), then redeploy.
-- Date: 2026-10-14
-- ============================================

BEGIN;

DO $$
DECLARE
    collisions TEXT;
BEGIN
    SELECT string_agg(format('%s (%s rows)', lower_pubkey, n), ', ')
    INTO collisions
    FROM (
        SELECT lower(owner_pubkey) AS lower_pubkey, count(*) AS n
        FROM boltcard_issuer_keys
        GROUP BY lower(owner_pubkey)
        HAVING count(*) > 1
    ) groups;

    IF collisions IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 023 aborted: boltcard_issuer_keys has case-variant collisions that need manual remediation (see migration header): %', collisions;
    END IF;
END $$;

-- No collisions: each issuer-key row maps to a distinct lowercase pubkey.
UPDATE boltcard_issuer_keys
SET owner_pubkey = lower(owner_pubkey)
WHERE owner_pubkey <> lower(owner_pubkey);

UPDATE boltcards
SET owner_pubkey = lower(owner_pubkey)
WHERE owner_pubkey <> lower(owner_pubkey);

UPDATE boltcard_pending_registrations
SET owner_pubkey = lower(owner_pubkey)
WHERE owner_pubkey <> lower(owner_pubkey);

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    23,
    'version',
    '{"description": "Normalize Bolt Card owner pubkeys to lowercase", "date": "2026-10-14"}'
);

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Migration 023 completed: Bolt Card owner pubkeys lowercase';
END $$;

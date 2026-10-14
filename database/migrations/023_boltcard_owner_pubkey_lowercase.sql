-- ============================================
-- BOLTCARD OWNER PUBKEY NORMALIZATION
-- Version: 023
-- Description: Store Bolt Card owner pubkeys lowercase (hex). Owners are now
--              identified by their Nostr session pubkey (lowercase); rows
--              created earlier stored whatever case the client sent, and the
--              owner lookups are case-sensitive.
--
--              boltcards / boltcard_pending_registrations: plain normalization
--              (no uniqueness on owner_pubkey).
--              boltcard_issuer_keys (owner_pubkey is the PRIMARY KEY): per
--              lower(owner_pubkey) group, exactly one row becomes the lowercase
--              key - an existing lowercase row wins, otherwise the oldest.
--              Any other variant in a colliding group is left untouched and
--              reported with a WARNING (failing here would block the
--              migration init container). Card wipe keys do not depend on it:
--              each card stores its own K0-K4.
-- Date: 2026-10-14
-- ============================================

UPDATE boltcards
SET owner_pubkey = lower(owner_pubkey)
WHERE owner_pubkey <> lower(owner_pubkey);

UPDATE boltcard_pending_registrations
SET owner_pubkey = lower(owner_pubkey)
WHERE owner_pubkey <> lower(owner_pubkey);

WITH ranked AS (
    SELECT
        owner_pubkey,
        row_number() OVER (
            PARTITION BY lower(owner_pubkey)
            ORDER BY (owner_pubkey = lower(owner_pubkey)) DESC, created_at ASC
        ) AS rn
    FROM boltcard_issuer_keys
)
UPDATE boltcard_issuer_keys k
SET owner_pubkey = lower(k.owner_pubkey)
FROM ranked r
WHERE r.owner_pubkey = k.owner_pubkey
  AND r.rn = 1
  AND k.owner_pubkey <> lower(k.owner_pubkey);

DO $$
DECLARE
    leftover INTEGER;
BEGIN
    SELECT COUNT(*) INTO leftover
    FROM boltcard_issuer_keys
    WHERE owner_pubkey <> lower(owner_pubkey);

    IF leftover > 0 THEN
        RAISE WARNING 'Migration 023: % mixed-case boltcard_issuer_keys row(s) collide with an existing lowercase key and were left as-is; resolve manually (recover-keys for cards derived from them will not work)', leftover;
    END IF;
END $$;

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, tags)
VALUES (
    'schema_version',
    23,
    'version',
    '{"description": "Normalize Bolt Card owner pubkeys to lowercase", "date": "2026-10-14"}'
);

DO $$
BEGIN
    RAISE NOTICE 'Migration 023 completed: Bolt Card owner pubkeys lowercase';
END $$;

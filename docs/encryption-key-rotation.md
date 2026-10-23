# Rotating `ENCRYPTION_KEY`

`ENCRYPTION_KEY` protects every secret blink-terminal stores (blink-wip#1587):

| Where | What |
|---|---|
| `vouchers.api_key_encrypted` | voucher funding wallet API key (`''` = scrubbed) |
| `boltcards.api_key_encrypted`, `k0_encrypted`–`k4_encrypted` | card wallet API key, card keys |
| `boltcard_issuer_keys.issuer_key_encrypted` | per-owner issuer key |
| `boltcard_pending_registrations.api_key_encrypted` | API key of a pending card |
| `data_sharing_consents.blink_api_key_encrypted` | community consent API key |
| `user_records.data` (JSONB): `apiKey`, `blinkApiAccounts[*].apiKey`, `nwcConnections[*].uri`, `voucherWallet.apiKey` | user API keys, NWC URIs |
| `payment_splits.metadata` (JSONB): `userApiKey`, `nwcConnectionUri` — and the Redis copy | payment-in-progress API key / NWC URI |

All of it goes through `lib/crypto/keyring.js`:

- **v2 values** — `v2.<kid>.<…>`, AES-256-GCM, tagged with the writing key's 64-bit id — are read with the key whose id matches, among `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS` (comma-separated, newest first). Two different configured keys with the same id are refused.
- **Legacy values** (CryptoJS format, `U2FsdGVkX1…`) are read with the **oldest** configured key — never tried against several keys (no integrity check).
- **Writes** follow `ENCRYPTION_WRITE_FORMAT`: `legacy` (default) or `v2`.

`NETWORK_ENCRYPTION_KEY` currently encrypts nothing (`lib/network/crypto.ts` has no callers); rotating it has no effect.

## Prerequisites (deployment plumbing)

- **charts**: blinkbitcoin/charts#9563 — maps `ENCRYPTION_KEY_PREVIOUS` (secret key `encryption-key-previous`, optional) and `ENCRYPTION_WRITE_FORMAT` (`blinkTerminal.encryptionWriteFormat`) into the pod.
- **blink-deployments**: blinkbitcoin/blink-deployments#10595 — sources `encryption-key-previous` from the environment's secrets (`blink_terminal_encryption_key_previous`, only when present) and the write format from `blink_terminal_encryption_write_format`.

Phase 1 needs neither. Phase 2 needs the write-format plumbing; a rotation needs both.

## Phase 1 — reader-first deploy (rollback-safe)

Deploy the release containing the keyring with **no configuration change**. It reads legacy and v2 values but still **writes legacy**, byte-compatible with every earlier release. Rolling the image back is safe at any point.

`scripts/reencrypt-secrets.js` may be run as a dry run; `--apply` and `--check` refuse to run in this phase.

## Phase 2 — switch writes to v2

Once phase 1 is fully deployed in the environment:

1. Set `blink_terminal_encryption_write_format = "v2"` (blink-deployments) and apply. New writes are v2.
2. **From now on the minimum rollback version is the keyring release** — earlier images cannot read v2. Do not roll back past it.
3. Re-encrypt existing values (in an app pod, which has the database URL and keys):

   ```bash
   kubectl exec -n <ns> deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js           # dry run
   kubectl exec -n <ns> deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js --apply
   kubectl exec -n <ns> deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js --check   # exit 0 = all current
   ```

   `--check` authenticates every value: a value is current only when the current key decrypts it. It **fails** on anything unreadable — ciphertext no configured key authenticates, plaintext or damaged values in an encrypted column, plaintext at a known JSON secret path — listing table, key and column (never plaintext). The one exception is `payment_splits.metadata.userApiKey`, which the app still reads raw for pre-encryption rows: a raw `blink_…` key there is encrypted by `--apply`. Conflicts (rows changed meanwhile): re-run.

## Rotation (phase 2 only)

Legacy writes during a rotation are refused by the app, so rotate only after phase 2.

1. Generate a new key (`openssl rand -hex 32`).
2. In the environment's secrets set `blink_terminal_encryption_key = <new>` and `blink_terminal_encryption_key_previous = <old>`; apply. Existing values keep decrypting (by key id); new writes use the new key.
3. `--apply`, then `--check` until it exits 0. Investigate anything listed as undecryptable — the app cannot read it either.
4. Wait at least the longest lifetime of a value outside Postgres (Redis payment metadata: the invoice expiry), then remove `blink_terminal_encryption_key_previous`; apply.

Never remove the previous key before step 3 passes: values still under it become unreadable.

## Notes

- `JWT_SECRET` rotation is separate and needs no data migration: it ends all sessions (24 h lifetime).
- `scripts/reencrypt-secrets.js` and `scripts/reconcile-voucher-claims.js` ship in the app image.

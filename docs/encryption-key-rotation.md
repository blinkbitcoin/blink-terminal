# Rotating `ENCRYPTION_KEY`

`ENCRYPTION_KEY` protects every secret blink-terminal stores (blink-wip#1587):

| Where | What |
|---|---|
| `vouchers.api_key_encrypted` | voucher funding wallet API key |
| `boltcards.api_key_encrypted`, `k0_encrypted`–`k4_encrypted` | card wallet API key, card keys |
| `boltcard_issuer_keys.issuer_key_encrypted` | per-owner issuer key |
| `boltcard_pending_registrations.api_key_encrypted` | API key of a pending card |
| `data_sharing_consents.blink_api_key_encrypted` | community consent API key |
| `user_records.data` (JSONB) | nested API keys, NWC URIs |
| `payment_splits.metadata` (JSONB) and its Redis copy | payment-in-progress API key / NWC URI |

All of it goes through `lib/crypto/keyring.js`:

- **Writes** are `v2.<kid>.<…>` — AES-256-GCM under the current `ENCRYPTION_KEY`, tagged with that key's id.
- **Reads** of v2 use the key whose id matches, among `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS` (comma-separated, newest first).
- **Legacy values** (CryptoJS, written before #1587, starting `U2FsdGVkX1`) are read with the **oldest** configured key — the key that was in use before the first rotation. They are never tried against several keys (no integrity check), so they must be re-encrypted before a second rotation.

`NETWORK_ENCRYPTION_KEY` currently encrypts nothing (`lib/network/crypto.ts` has no callers); rotating it has no effect.

## Procedure

`scripts/reencrypt-secrets.js` ships in the app image. Run it in an app pod (it uses the pod's `DATABASE_URL` and keys):

```bash
kubectl exec -n <ns> <blink-terminal pod> -- node scripts/reencrypt-secrets.js           # dry run
kubectl exec -n <ns> <blink-terminal pod> -- node scripts/reencrypt-secrets.js --apply
kubectl exec -n <ns> <blink-terminal pod> -- node scripts/reencrypt-secrets.js --check   # exit 0 = all current
```

**Once, after deploying #1587** (no env change): `--apply`, then `--check`. Every legacy value becomes v2 under the current key.

**Each rotation:**

1. Generate a new key (`openssl rand -hex 32`).
2. Set `ENCRYPTION_KEY=<new>` and `ENCRYPTION_KEY_PREVIOUS=<old>` in the chart secret; deploy. Existing values keep decrypting (by key id); new writes use the new key.
3. `--apply`, then `--check` until it exits 0. Rows that changed while the script ran are reported as conflicts — re-run. Values listed as *undecryptable* are left untouched: investigate them (they cannot be read by the app either).
4. Wait at least the longest lifetime of a value that is not in Postgres (Redis payment metadata: the invoice expiry), then remove `ENCRYPTION_KEY_PREVIOUS`; deploy.

Never remove the previous key before step 3 passes: values still under it become unreadable.

## Notes

- `JWT_SECRET` rotation is separate and needs no data migration: it ends all sessions (24 h lifetime).
- The script logs table, key and column for problems, never plaintext.

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

`NETWORK_ENCRYPTION_KEY` is retired: it encrypted nothing (the network module's consent API keys go through the keyring above), and the app no longer reads it. Removing it from the chart and blink-deployments follows charts#9563 and blink-deployments#10595.

## Prerequisites (deployment plumbing)

- **charts**: blinkbitcoin/charts#9563 — maps `ENCRYPTION_KEY_PREVIOUS` (secret key `encryption-key-previous`, optional) and `ENCRYPTION_WRITE_FORMAT` (`blinkTerminal.encryptionWriteFormat`) into the pod, and **rolls the pod when its secret changes** (`secretVersion` annotation).
- **blink-deployments**: blinkbitcoin/blink-deployments#10595 — sources `encryption-key-previous` from the environment's secrets (`blink_terminal_encryption_key_previous`, only when present), the write format from `blink_terminal_encryption_write_format`, and passes the Secret's `resourceVersion` as `secretVersion` so `apply` rolls the pod and waits for it.

**Why the restart matters:** environment variables are read when a pod starts. A pod that has not restarted after a key change still runs with the old keys — the re-encryption script run inside it would report old-key values as current, and the next restart (kube-monkey kills blink-terminal pods at random) would then lose access to them. Every step below therefore verifies the rollout and the key ids the pod actually runs with.

**Merge order.** blink-deployments deploys a *vendored* copy of the chart, not charts `main`:

1. charts#9563 merges;
2. the bot bumps the vendored chart on blink-deployments `main` (`chore: bump blink-terminal-chart to '<sha>'`);
3. blink-deployments#10595 is refreshed from `main` and merged. Its Terraform precondition refuses to deploy a vendored chart without the secret-change rollout, so an out-of-order merge fails `apply` loudly rather than deploying stale pods.

Before phase 2 or a rotation, confirm in blink-deployments that `modules/services/addons/vendor/blink-terminal/chart/templates/deployment.yaml` contains `blink-terminal/secret-version`.

Phase 1 needs none of this. Phase 2 needs the write-format plumbing; a rotation needs all of it.

## Phase 1 — reader-first deploy (rollback-safe)

Deploy the release containing the keyring with **no configuration change**. It reads legacy and v2 values but still **writes legacy**, byte-compatible with every earlier release. Rolling the image back is safe at any point.

`scripts/reencrypt-secrets.js` may be run as a dry run; `--apply` and `--check` refuse to run in this phase.

## Checking what a pod runs with

```bash
NS=<namespace>
kubectl -n $NS rollout status deploy/blink-terminal
kubectl -n $NS exec deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js
# first line: Keys: current=<kid> previous=[<kid>,…] writeFormat=<legacy|v2>
```

Key ids are fingerprints, not secrets. To get the id of a key without putting it on a command line:

```bash
printf '%s' "$NEW_KEY" | kubectl -n $NS exec -i deploy/blink-terminal -c blink-terminal -- \
  node scripts/reencrypt-secrets.js --key-id-of-stdin
```

`--expect-key-id <kid>` makes any run refuse unless the pod's current key id is `<kid>`.

## Phase 2 — switch writes to v2

Once phase 1 is fully deployed in the environment:

1. Set `blink_terminal_encryption_write_format = "v2"` (blink-deployments) and apply. The value is an env var in the pod template, so the pod rolls; `kubectl rollout status` must report success.
2. Confirm the pod runs with `writeFormat=v2` (see above). **From now on the minimum rollback version is the keyring release** — earlier images cannot read v2. Do not roll back past it.
3. Re-encrypt existing values:

   ```bash
   kubectl -n $NS exec deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js           # dry run
   kubectl -n $NS exec deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js --apply
   kubectl -n $NS exec deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js --check   # exit 0 = all current
   ```

   `--check` authenticates every value: a value is current only when the current key decrypts it. It **fails** on anything unreadable — ciphertext no configured key authenticates, plaintext or damaged values in an encrypted column, plaintext at a known JSON secret path — listing table, key and column (never plaintext). The one exception is `payment_splits.metadata.userApiKey`, which the app still reads raw for pre-encryption rows: a raw `blink_…` / `galoy_staging_…` key there is encrypted by `--apply`. Conflicts (rows changed meanwhile): re-run.

## Rotation (phase 2 only)

Legacy writes during a rotation are refused by the app, so rotate only after phase 2.

1. Generate a new key (`openssl rand -hex 32`) and compute its id with `--key-id-of-stdin` (above). Note the current id too (the first line of a dry run).
2. In the environment's secrets set `blink_terminal_encryption_key = <new>` and `blink_terminal_encryption_key_previous = <old>`; apply. The Secret changes, so the pod rolls and `apply` waits for it. Confirm with `kubectl rollout status`, then a dry run must print `current=<new id> previous=[<old id>]`.
3. Re-encrypt, pinned to the new key so a stale pod cannot run it:

   ```bash
   kubectl -n $NS exec deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js --apply --expect-key-id <new id>
   kubectl -n $NS exec deploy/blink-terminal -c blink-terminal -- node scripts/reencrypt-secrets.js --check --expect-key-id <new id>
   ```

   Repeat `--check` until it exits 0. Investigate anything listed as undecryptable — the app cannot read it either.
4. Wait at least the longest lifetime of a value outside Postgres (Redis payment metadata: the invoice expiry), then remove `blink_terminal_encryption_key_previous`; apply. The pod rolls again: confirm `kubectl rollout status`, a dry run printing `current=<new id> previous=[]`, and `--check --expect-key-id <new id>` still exiting 0 **in the new pod**.

Never remove the previous key before step 3 passes: values still under it become unreadable.

## Notes

- `JWT_SECRET` rotation is separate and needs no data migration: it ends all sessions (24 h lifetime).
- `scripts/reencrypt-secrets.js` and `scripts/reconcile-voucher-claims.js` ship in the app image.

/** @jest-environment node */

/**
 * Key rotation on real Postgres (blink-wip#1587): scripts/reencrypt-secrets.js
 * rewrites every legacy / previous-key secret in every encrypted column and
 * nested JSONB field under the current key, with the same plaintext, leaves
 * undecryptable and non-ciphertext values alone, and skips rows that changed
 * meanwhile (compare-and-set).
 */

// Must stay first: sets the env lib/auth reads at module load.
import "./env"

import { spawnSync } from "child_process"
import path from "path"

import CryptoJS from "crypto-js"
import { Pool, type Client } from "pg"

import { createKeyring, keyId } from "../../../lib/crypto/keyring"

import { describePg, setupTestDatabase, type TestDatabase } from "./harness"

/* eslint-disable @typescript-eslint/no-require-imports */
const { reencryptSecrets } = require("../../../scripts/reencrypt-secrets")
/* eslint-enable @typescript-eslint/no-require-imports */

jest.setTimeout(60_000)

const K1 = "rotation-old-key-0123456789abcdef"
const K2 = "rotation-new-key-0123456789abcdef"
const COMMUNITY = "a1b2c3d4-e5f6-7890-abcd-ef1234567001" // seeded by migration 003

const legacy = (plaintext: string) => CryptoJS.AES.encrypt(plaintext, K1).toString()
const v2K1 = (plaintext: string) =>
  createKeyring({ current: K1, writeFormat: "v2" }).encrypt(plaintext)
const v2K2 = (plaintext: string) =>
  createKeyring({ current: K2, writeFormat: "v2" }).encrypt(plaintext)
const unknownKey = createKeyring({ current: "some-lost-key", writeFormat: "v2" }).encrypt(
  "lost",
)

describePg("reencrypt-secrets on real Postgres", () => {
  let db: TestDatabase
  let sql: Client
  let pool: Pool
  const rotated = createKeyring({ current: K2, previous: K1, writeFormat: "v2" })

  beforeAll(async () => {
    db = await setupTestDatabase("reencrypt")
    sql = await db.connect()
    pool = new Pool({ connectionString: db.url, max: 4 })
  })
  afterAll(async () => {
    await pool?.end()
    await sql?.end()
    await db?.teardown()
  })

  const seed = async () => {
    await sql.query(
      `TRUNCATE vouchers, boltcards, boltcard_issuer_keys, boltcard_pending_registrations,
                data_sharing_consents, community_memberships, user_records, payment_splits CASCADE`,
    )
    const now = Date.now()
    await sql.query(
      `INSERT INTO vouchers (id, amount_sats, wallet_id, api_key_encrypted, status, claimed,
                             created_at, expires_at, expiry_id, wallet_currency)
       VALUES ('v-legacy', 500, 'w1', $1, 'ACTIVE', false, $3, $4, '24h', 'BTC'),
              ('v-current', 500, 'w1', $2, 'ACTIVE', false, $3, $4, '24h', 'BTC'),
              ('v-lost', 500, 'w1', $5, 'ACTIVE', false, $3, $4, '24h', 'BTC')`,
      [
        legacy("blink_voucher_legacy"),
        v2K2("blink_voucher_current"),
        now,
        now + 3_600_000,
        unknownKey,
      ],
    )
    await sql.query(
      `INSERT INTO boltcards (id, card_uid, owner_pubkey, wallet_id, api_key_encrypted,
                              k0_encrypted, k1_encrypted, k2_encrypted, k3_encrypted, k4_encrypted,
                              status, created_at)
       VALUES ('card-1', '04a39493cc8680', $1, 'w1', $2, $3, $4, $5, NULL, $6, 'ACTIVE', $7)`,
      [
        "a".repeat(64),
        legacy("blink_card_key"),
        v2K1("k0hex"),
        legacy("k1hex"),
        v2K2("k2hex"),
        v2K1("k4hex"),
        now,
      ],
    )
    await sql.query(
      `INSERT INTO boltcard_issuer_keys (owner_pubkey, issuer_key_encrypted, created_at)
       VALUES ($1, $2, $3)`,
      ["b".repeat(64), legacy("issuer-key-hex"), now],
    )
    await sql.query(
      `INSERT INTO boltcard_pending_registrations
         (id, owner_pubkey, wallet_id, api_key_encrypted, created_at, expires_at)
       VALUES ('reg-1', $1, 'w1', $2, $3, $4)`,
      ["c".repeat(64), v2K1("blink_pending_key"), now, now + 600_000],
    )
    const { rows } = await sql.query(
      `INSERT INTO community_memberships (community_id, user_npub) VALUES ($1, 'npub1x') RETURNING id`,
      [COMMUNITY],
    )
    await sql.query(
      `INSERT INTO data_sharing_consents (membership_id, user_npub, community_id, blink_api_key_encrypted)
       VALUES ($1, 'npub1x', $2, $3)`,
      [rows[0].id, COMMUNITY, legacy("blink_consent_key")],
    )
    await sql.query(`INSERT INTO user_records (user_hash, data) VALUES ($1, $2::jsonb)`, [
      "d".repeat(64),
      JSON.stringify({
        wallets: [
          { label: "main", apiKey: legacy("blink_wallet_key") },
          { apiKey: v2K2("blink_ok") },
        ],
        nwc: { uri: v2K1("nostr+walletconnect://secret") },
        preferences: { theme: "dark", note: "not a secret" },
      }),
    ])
    await sql.query(
      `INSERT INTO payment_splits (payment_hash, user_api_key_hash, user_wallet_id, total_amount,
                                   base_amount, tip_amount, metadata, expires_at)
       VALUES ($1, 'h', 'w1', 100, 100, 0, $2::jsonb, NOW() + interval '1 hour')`,
      [
        "e".repeat(64),
        JSON.stringify({ userApiKey: v2K1("blink_payment_key"), tipRecipients: [] }),
      ],
    )
  }

  const value = async (q: string) => (await sql.query(q)).rows[0].v as string

  beforeEach(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {})
    await seed()
  })

  it("dry run reports what needs rewriting and writes nothing", async () => {
    const before = await value(
      "SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-legacy'",
    )
    const r = await reencryptSecrets({
      pool,
      keyring: rotated,
      apply: false,
      log: () => {},
    })
    // legacy: voucher, card api, k1, issuer, consent, user wallet = 6;
    // v2(K1): k0, k4, pending reg, user nwc, payment = 5
    expect(r.pending).toBe(11)
    expect(r.rewritten).toBe(0)
    expect(r.undecryptable).toEqual(["vouchers[v-lost].api_key_encrypted"])
    expect(
      await value("SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-legacy'"),
    ).toBe(before)
  })

  it("--apply rewrites everything under the current key with the same plaintext", async () => {
    const r = await reencryptSecrets({
      pool,
      keyring: rotated,
      apply: true,
      log: () => {},
    })
    expect(r).toMatchObject({ pending: 11, rewritten: 11, conflicts: 0 })

    const newKid = keyId(K2)
    const check = async (q: string, plaintext: string) => {
      const v = await value(q)
      expect(v.split(".")[1]).toBe(newKid)
      expect(rotated.decrypt(v)).toBe(plaintext)
      // ...and decryptable without the previous key once rotation completes
      expect(createKeyring({ current: K2, writeFormat: "v2" }).decrypt(v)).toBe(plaintext)
    }
    await check(
      "SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-legacy'",
      "blink_voucher_legacy",
    )
    await check("SELECT k0_encrypted AS v FROM boltcards", "k0hex")
    await check("SELECT k1_encrypted AS v FROM boltcards", "k1hex")
    await check("SELECT k4_encrypted AS v FROM boltcards", "k4hex")
    await check(
      "SELECT issuer_key_encrypted AS v FROM boltcard_issuer_keys",
      "issuer-key-hex",
    )
    await check(
      "SELECT api_key_encrypted AS v FROM boltcard_pending_registrations",
      "blink_pending_key",
    )
    await check(
      "SELECT blink_api_key_encrypted AS v FROM data_sharing_consents",
      "blink_consent_key",
    )
    await check(
      "SELECT data->'wallets'->0->>'apiKey' AS v FROM user_records",
      "blink_wallet_key",
    )
    await check(
      "SELECT data->'nwc'->>'uri' AS v FROM user_records",
      "nostr+walletconnect://secret",
    )
    await check(
      "SELECT metadata->>'userApiKey' AS v FROM payment_splits",
      "blink_payment_key",
    )

    // Untouched: already current, non-ciphertext JSON, NULL column, undecryptable
    const current = await value(
      "SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-current'",
    )
    expect(rotated.decrypt(current)).toBe("blink_voucher_current")
    expect(
      await value("SELECT data->'preferences'->>'note' AS v FROM user_records"),
    ).toBe("not a secret")
    expect(await value("SELECT k3_encrypted AS v FROM boltcards")).toBeNull()
    expect(
      await value("SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-lost'"),
    ).toBe(unknownKey)
    expect(r.undecryptable).toEqual(["vouchers[v-lost].api_key_encrypted"])
  })

  it("a second run finds nothing left (idempotent); check passes once the lost value is resolved", async () => {
    await reencryptSecrets({ pool, keyring: rotated, apply: true, log: () => {} })
    const again = await reencryptSecrets({
      pool,
      keyring: rotated,
      apply: false,
      log: () => {},
    })
    expect(again.pending).toBe(0)
    expect(again.undecryptable).toHaveLength(1)
    await sql.query("DELETE FROM vouchers WHERE id = 'v-lost'")
    const clean = await reencryptSecrets({
      pool,
      keyring: rotated,
      apply: false,
      log: () => {},
    })
    expect(clean).toMatchObject({ pending: 0, undecryptable: [] })
  })

  it("compare-and-set: a row changed meanwhile is skipped, the concurrent value kept", async () => {
    const concurrent = v2K2("blink_rotated_by_app")
    let raced = false
    const racingPool = {
      query: async (text: string, params?: unknown[]) => {
        if (!raced && text.startsWith("UPDATE vouchers") && params?.[0] === "v-legacy") {
          raced = true // the app rewrites the row between our read and our write
          await sql.query(
            "UPDATE vouchers SET api_key_encrypted = $1 WHERE id = 'v-legacy'",
            [concurrent],
          )
        }
        return pool.query(text, params)
      },
    }
    const r = await reencryptSecrets({
      pool: racingPool,
      keyring: rotated,
      apply: true,
      log: () => {},
    })
    expect(r.conflicts).toBe(1)
    expect(r.rewritten).toBe(10)
    expect(
      await value("SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-legacy'"),
    ).toBe(concurrent)
  })

  it("CLI: --check fails before, --apply rewrites, --check passes after (exit codes)", async () => {
    const cli = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [path.join(process.cwd(), "scripts", "reencrypt-secrets.js"), ...args],
        {
          env: {
            ...process.env,
            DATABASE_URL: db.url,
            ENCRYPTION_KEY: K2,
            ENCRYPTION_KEY_PREVIOUS: K1,
            ENCRYPTION_WRITE_FORMAT: "v2",
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      )
    await sql.query("DELETE FROM vouchers WHERE id = 'v-lost'")

    const before = cli("--check")
    expect(before.status).toBe(1)
    expect(before.stdout).toContain("CHECK FAILED")
    expect(before.stdout).toContain(`Current key id: ${keyId(K2)}`)

    const applied = cli("--apply")
    expect(applied.status).toBe(0)
    expect(applied.stdout).toContain("rewritten=11")

    const after = cli("--check")
    expect(after.status).toBe(0)
    expect(after.stdout).toContain("CHECK OK")

    // The script's output never contains a plaintext secret
    const plaintexts = [
      "blink_voucher_legacy",
      "blink_card_key",
      "k0hex",
      "k1hex",
      "k4hex",
      "issuer-key-hex",
      "blink_pending_key",
      "blink_consent_key",
      "blink_wallet_key",
      "nostr+walletconnect://secret",
      "blink_payment_key",
    ]
    for (const out of [before.stdout, applied.stdout, after.stdout]) {
      for (const secret of plaintexts) expect(out).not.toContain(secret)
    }
  })

  it("a tampered value under the CURRENT key id is reported undecryptable and fails --check", async () => {
    // The reviewer's probe: kid = current key id, GCM tag modified.
    const good = v2K2("blink_tampered")
    const [v, kid, payload] = good.split(".")
    const bytes = Buffer.from(payload, "base64")
    bytes[12] ^= 0x01
    const tampered = `${v}.${kid}.${bytes.toString("base64")}`
    await sql.query("DELETE FROM vouchers WHERE id = 'v-lost'")
    const now = Date.now()
    await sql.query(
      `INSERT INTO vouchers (id, amount_sats, wallet_id, api_key_encrypted, status, claimed,
                             created_at, expires_at, expiry_id, wallet_currency)
       VALUES ('v-tampered', 500, 'w1', $1, 'ACTIVE', false, $2, $3, '24h', 'BTC')`,
      [tampered, now, now + 3_600_000],
    )
    await reencryptSecrets({ pool, keyring: rotated, apply: true, log: () => {} })

    const r = await reencryptSecrets({
      pool,
      keyring: rotated,
      apply: false,
      log: () => {},
    })
    expect(r.pending).toBe(0)
    expect(r.undecryptable).toEqual(["vouchers[v-tampered].api_key_encrypted"])
    // never counted as current: only the 3 genuinely current + 11 rewritten
    expect(r.current).toBe(14)

    const check = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "reencrypt-secrets.js"), "--check"],
      {
        env: {
          ...process.env,
          DATABASE_URL: db.url,
          ENCRYPTION_KEY: K2,
          ENCRYPTION_KEY_PREVIOUS: K1,
          ENCRYPTION_WRITE_FORMAT: "v2",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    )
    expect(check.status).toBe(1)
    expect(check.stdout).toContain("CHECK FAILED")
    expect(check.stdout).toContain(
      "[undecryptable] vouchers[v-tampered].api_key_encrypted",
    )
    expect(
      (
        await sql.query(
          "SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-tampered'",
        )
      ).rows[0].v,
    ).toBe(tampered) // left untouched
  })

  describe("strict gate: plaintext and damaged ciphertext where only ciphertext is valid", () => {
    const cli = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [path.join(process.cwd(), "scripts", "reencrypt-secrets.js"), ...args],
        {
          env: {
            ...process.env,
            DATABASE_URL: db.url,
            ENCRYPTION_KEY: K2,
            ENCRYPTION_KEY_PREVIOUS: K1,
            ENCRYPTION_WRITE_FORMAT: "v2",
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      )
    const insertVoucher = async (id: string, apiKeyEncrypted: string) => {
      const now = Date.now()
      await sql.query(
        `INSERT INTO vouchers (id, amount_sats, wallet_id, api_key_encrypted, status, claimed,
                               created_at, expires_at, expiry_id, wallet_currency)
         VALUES ($1, 500, 'w1', $2, 'PAID', true, $3, $4, '24h', 'BTC')`,
        [id, apiKeyEncrypted, now, now + 3_600_000],
      )
    }
    const damagedPrefix = (ct: string) => `x${ct.substring(1)}` // "v2." -> "x2."

    beforeEach(async () => {
      await sql.query("DELETE FROM vouchers WHERE id = 'v-lost'")
      await reencryptSecrets({ pool, keyring: rotated, apply: true, log: () => {} })
    })

    it("scalar column: plaintext and a damaged prefix are undecryptable and fail --check; '' is ignored", async () => {
      await insertVoucher("v-plain", "blink_plaintext_in_encrypted_column")
      await insertVoucher("v-prefix", damagedPrefix(v2K2("blink_damaged")))
      await insertVoucher("v-scrubbed", "") // #100 scrub marker for old PAID rows

      const r = await reencryptSecrets({
        pool,
        keyring: rotated,
        apply: false,
        log: () => {},
      })
      expect(r.undecryptable.sort()).toEqual([
        "vouchers[v-plain].api_key_encrypted",
        "vouchers[v-prefix].api_key_encrypted",
      ])
      const check = cli("--check")
      expect(check.status).toBe(1)
      expect(check.stdout).toContain("CHECK FAILED")
      expect(check.stdout).not.toContain("blink_plaintext_in_encrypted_column")
      expect(check.stdout).not.toContain("v-scrubbed")
    })

    it("known JSON secret paths: plaintext / damaged values are undecryptable; unknown paths are not secrets", async () => {
      await sql.query(
        `INSERT INTO user_records (user_hash, data) VALUES ($1, $2::jsonb)`,
        [
          "f".repeat(64),
          JSON.stringify({
            apiKey: "blink_raw_top_level",
            blinkApiAccounts: [{ apiKey: damagedPrefix(v2K2("blink_acc")) }],
            nwcConnections: [{ uri: "nostr+walletconnect://raw-secret" }],
            voucherWallet: { apiKey: 12345 },
            preferences: { note: "plain text, not a secret path" },
          }),
        ],
      )
      await sql.query(
        `INSERT INTO payment_splits (payment_hash, user_api_key_hash, user_wallet_id, total_amount,
                                     base_amount, tip_amount, metadata, expires_at)
         VALUES ($1, 'h', 'w1', 100, 100, 0, $2::jsonb, NOW() + interval '1 hour')`,
        [
          "a".repeat(64),
          JSON.stringify({ nwcConnectionUri: "nostr+walletconnect://raw" }),
        ],
      )
      const r = await reencryptSecrets({
        pool,
        keyring: rotated,
        apply: false,
        log: () => {},
      })
      const pk = (
        await sql.query("SELECT id FROM payment_splits WHERE payment_hash = $1", [
          "a".repeat(64),
        ])
      ).rows[0].id
      expect(r.undecryptable.sort()).toEqual(
        [
          `payment_splits[${pk}].metadata.nwcConnectionUri`,
          `user_records[${"f".repeat(64)}].data.apiKey`,
          `user_records[${"f".repeat(64)}].data.blinkApiAccounts[0].apiKey`,
          `user_records[${"f".repeat(64)}].data.nwcConnections[0].uri`,
          `user_records[${"f".repeat(64)}].data.voucherWallet.apiKey`,
        ].sort(),
      )
      expect(cli("--check").status).toBe(1)
    })

    it("metadata.userApiKey: a raw staging key (galoy_staging_…, accepted by the app) is migrated too", async () => {
      await sql.query(
        `INSERT INTO payment_splits (payment_hash, user_api_key_hash, user_wallet_id, total_amount,
                                     base_amount, tip_amount, metadata, expires_at)
         VALUES ($1, 'h', 'w1', 100, 100, 0, $2::jsonb, NOW() + interval '1 hour')`,
        ["d".repeat(64), JSON.stringify({ userApiKey: "galoy_staging_example_123" })],
      )
      expect(cli("--apply").status).toBe(0)
      const v = (
        await sql.query(
          "SELECT metadata->>'userApiKey' AS v FROM payment_splits WHERE payment_hash = $1",
          ["d".repeat(64)],
        )
      ).rows[0].v as string
      expect(rotated.decrypt(v)).toBe("galoy_staging_example_123")
      expect(cli("--check").status).toBe(0)
    })

    it("metadata.userApiKey: a raw Blink key (still accepted by the app) is migrated; other raw values are not", async () => {
      await sql.query(
        `INSERT INTO payment_splits (payment_hash, user_api_key_hash, user_wallet_id, total_amount,
                                     base_amount, tip_amount, metadata, expires_at)
         VALUES ($1, 'h', 'w1', 100, 100, 0, $2::jsonb, NOW() + interval '1 hour'),
                ($3, 'h', 'w1', 100, 100, 0, $4::jsonb, NOW() + interval '1 hour')`,
        [
          "b".repeat(64),
          JSON.stringify({ userApiKey: "blink_rawPreEncryptionKey123" }),
          "c".repeat(64),
          JSON.stringify({ userApiKey: "x2.notablinkkey" }),
        ],
      )
      const applied = cli("--apply")
      expect(applied.status).toBe(1) // the malformed one is undecryptable
      const migrated = (
        await sql.query(
          "SELECT metadata->>'userApiKey' AS v FROM payment_splits WHERE payment_hash = $1",
          ["b".repeat(64)],
        )
      ).rows[0].v as string
      expect(migrated.split(".")[1]).toBe(keyId(K2))
      expect(rotated.decrypt(migrated)).toBe("blink_rawPreEncryptionKey123")
      const malformed = (
        await sql.query(
          "SELECT metadata->>'userApiKey' AS v FROM payment_splits WHERE payment_hash = $1",
          ["c".repeat(64)],
        )
      ).rows[0].v
      expect(malformed).toBe("x2.notablinkkey") // left untouched, listed
      expect(applied.stdout).toContain("].metadata.userApiKey — left untouched")
      expect(applied.stdout).not.toContain("blink_rawPreEncryptionKey123")
    })
  })

  it("rollback-safe phase: --apply and --check refuse without ENCRYPTION_WRITE_FORMAT=v2", async () => {
    const legacyRing = createKeyring({ current: K1 }) // phase 1 default
    await expect(
      reencryptSecrets({ pool, keyring: legacyRing, apply: true, log: () => {} }),
    ).rejects.toThrow("--apply requires ENCRYPTION_WRITE_FORMAT=v2")
    // a dry run is allowed (reporting only)
    await expect(
      reencryptSecrets({ pool, keyring: legacyRing, apply: false, log: () => {} }),
    ).resolves.toBeTruthy()
    const run = (arg: string) =>
      spawnSync(
        process.execPath,
        [path.join(process.cwd(), "scripts", "reencrypt-secrets.js"), arg],
        {
          env: {
            ...process.env,
            DATABASE_URL: db.url,
            ENCRYPTION_KEY: K1,
            ENCRYPTION_WRITE_FORMAT: "",
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      )
    for (const arg of ["--apply", "--check"]) {
      const out = run(arg)
      expect(out.status).toBe(1)
      expect(out.stderr).toContain("requires ENCRYPTION_WRITE_FORMAT=v2")
    }
  })

  describe("key configuration is visible and stale pods are refused", () => {
    const run = (args: string[], env: Record<string, string>, input?: string) =>
      spawnSync(
        process.execPath,
        [path.join(process.cwd(), "scripts", "reencrypt-secrets.js"), ...args],
        {
          env: { ...process.env, DATABASE_URL: db.url, ...env },
          encoding: "utf8",
          timeout: 30_000,
          input,
        },
      )
    const rotatedEnv = {
      ENCRYPTION_KEY: K2,
      ENCRYPTION_KEY_PREVIOUS: K1,
      ENCRYPTION_WRITE_FORMAT: "v2",
    }

    it("every run prints the key ids and write format it runs with", () => {
      const out = run([], rotatedEnv)
      expect(out.status).toBe(1) // v-lost is undecryptable in the seed
      expect(out.stdout).toContain(
        `Keys: current=${keyId(K2)} previous=[${keyId(K1)}] writeFormat=v2`,
      )
      expect(out.stdout).not.toContain(K1)
      expect(out.stdout).not.toContain(K2)
    })

    it("--expect-key-id refuses to run in a pod still on the old key (no writes)", async () => {
      const before = await value(
        "SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-legacy'",
      )
      // the pod has not restarted: still only the old key
      const stale = run(["--apply", "--expect-key-id", keyId(K2)], {
        ENCRYPTION_KEY: K1,
        ENCRYPTION_WRITE_FORMAT: "v2",
      })
      expect(stale.status).toBe(1)
      expect(stale.stderr).toContain(
        `runs with current key id ${keyId(K1)}, expected ${keyId(K2)}`,
      )
      expect(stale.stderr).toContain("has not restarted")
      expect(
        await value("SELECT api_key_encrypted AS v FROM vouchers WHERE id = 'v-legacy'"),
      ).toBe(before)

      await sql.query("DELETE FROM vouchers WHERE id = 'v-lost'")
      const fresh = run(["--apply", "--expect-key-id", keyId(K2)], rotatedEnv)
      expect(fresh.status).toBe(0)
      expect(fresh.stdout).toContain("rewritten=11")
    })

    it("--key-id-of-stdin prints a key's id without a database or the key in argv", () => {
      const out = run(
        ["--key-id-of-stdin"],
        { DATABASE_URL: "postgres://unused" },
        `${K2}\n`,
      )
      expect(out.status).toBe(0)
      expect(out.stdout.trim()).toBe(keyId(K2))
    })

    it("--expect-key-id validates its argument", () => {
      const out = run(["--check", "--expect-key-id", "nothex"], rotatedEnv)
      expect(out.status).toBe(1)
      expect(out.stderr).toContain("16-hex-character key id")
    })
  })

  it("refuses to run without a current key", async () => {
    await expect(
      reencryptSecrets({ pool, keyring: createKeyring({ previous: K1 }), log: () => {} }),
    ).rejects.toThrow("ENCRYPTION_KEY is required")
  })
})

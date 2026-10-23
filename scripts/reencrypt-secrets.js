#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Re-encrypt every secret at rest under the current ENCRYPTION_KEY
 * (blink-wip#1587). Part of the key-rotation runbook:
 * docs/encryption-key-rotation.md.
 *
 * Finds every value written by lib/crypto/keyring.js — legacy CryptoJS or v2
 * — in the known encrypted columns and in nested JSONB fields, authenticates
 * each one (keyring.inspect: a value counts as current only when the current
 * key authenticates it, never by its key id alone), and rewrites those that
 * are legacy or authenticated by a previous key:
 *   decrypt (keyring: ENCRYPTION_KEY + ENCRYPTION_KEY_PREVIOUS)
 *   -> encrypt under the current key -> verify it decrypts to the same
 *   plaintext -> UPDATE ... WHERE <pk> = $1 AND <col> = <old value>
 * The compare-and-set skips a row that changed meanwhile (counted as a
 * conflict; re-run to pick it up). Values that cannot be decrypted are left
 * untouched and listed (table, key, column), never overwritten.
 *
 * Strictness: in a dedicated *_encrypted column every non-empty value must be
 * ciphertext (plaintext or a damaged prefix is listed as undecryptable; ''
 * is the scrub marker and is ignored). In JSONB, the known secret paths
 * (JSON_TARGETS[].secretPaths) are held to the same rule, except where the
 * app itself still reads raw plaintext (metadata.userApiKey): a raw value of
 * the expected shape is migrated (encrypted), anything else is listed.
 * Ciphertext found at any other JSON path is rotated too.
 *
 * --apply and --check require ENCRYPTION_WRITE_FORMAT=v2: in the
 * rollback-safe phase (legacy writes) rewriting to v2 would strand the data
 * if the image were rolled back. A dry run works in either phase.
 *
 * Usage:
 *   node scripts/reencrypt-secrets.js            dry run: report only
 *   node scripts/reencrypt-secrets.js --apply    rewrite
 *   node scripts/reencrypt-secrets.js --check    exit 1 unless every value is
 *                                                under the current key
 *   ... --expect-key-id <kid>   refuse to run unless this process's current
 *                               key id is <kid> (guards against a pod that
 *                               has not restarted onto the new key yet)
 *   node scripts/reencrypt-secrets.js --key-id-of-stdin
 *                               print the key id of a key read from stdin
 *                               (no database; the key never appears in argv)
 *
 * Every run prints the key ids (fingerprints, not secrets) and write format
 * the process is actually running with: environment variables are read when
 * a pod starts, so after changing keys, confirm these before --apply.
 *
 * Requires ENCRYPTION_KEY (and ENCRYPTION_KEY_PREVIOUS while rotating), and
 * DATABASE_URL or POSTGRES_* for the database.
 */

const { Pool } = require("pg")

const { envKeyring, keyId } = require("../lib/crypto/keyring")

/** Plain text columns holding one ciphertext each. */
const COLUMN_TARGETS = [
  { table: "vouchers", key: "id", columns: ["api_key_encrypted"] },
  {
    table: "boltcards",
    key: "id",
    columns: [
      "api_key_encrypted",
      "k0_encrypted",
      "k1_encrypted",
      "k2_encrypted",
      "k3_encrypted",
      "k4_encrypted",
    ],
  },
  {
    table: "boltcard_issuer_keys",
    key: "owner_pubkey",
    columns: ["issuer_key_encrypted"],
  },
  { table: "boltcard_pending_registrations", key: "id", columns: ["api_key_encrypted"] },
  { table: "data_sharing_consents", key: "id", columns: ["blink_api_key_encrypted"] },
]

/** JSONB columns whose nested string values may be ciphertext. */
/**
 * JSONB columns whose nested string values may be ciphertext. `secretPaths`
 * are where the app stores secrets ("*" = any array index); `raw` is the
 * shape of a legacy plaintext value the app still accepts at that path
 * (migrated rather than rejected), or null when plaintext is never valid.
 */
// The API key formats the app accepts (pages/api/network/consent.ts):
// "blink_…" (mainnet) and "galoy_staging_…" (staging/signet).
const BLINK_API_KEY = /^(blink|galoy_staging)_[A-Za-z0-9_]+$/
const JSON_TARGETS = [
  {
    table: "user_records",
    key: "user_hash",
    column: "data",
    // writers/readers: lib/storage.ts, pages/api/user/sync.ts
    secretPaths: [
      { path: ["apiKey"], raw: null },
      { path: ["blinkApiAccounts", "*", "apiKey"], raw: null },
      { path: ["nwcConnections", "*", "uri"], raw: null },
      { path: ["voucherWallet", "apiKey"], raw: null },
    ],
  },
  {
    table: "payment_splits",
    key: "id",
    column: "metadata",
    // writer: lib/storage/hybrid-store.ts storeTipData; readers: hybrid-store
    // (userApiKey, raw fallback for pre-encryption rows), webhook (NWC URI)
    secretPaths: [
      { path: ["userApiKey"], raw: BLINK_API_KEY },
      { path: ["nwcConnectionUri"], raw: null },
    ],
  },
]

const BATCH = 500

/**
 * Rewrite `value` if it needs it. Returns the new ciphertext, or null when
 * nothing should change; records the outcome in `tally`.
 */
/**
 * In a dry run (`apply` false) nothing is encrypted: a value that would be
 * rewritten is counted and returned unchanged (non-null = "would change").
 */
function rewrite(
  value,
  keyring,
  tally,
  where,
  { strict = false, raw = null, apply = true } = {},
) {
  if (value === null || value === undefined) return null
  const { status, plaintext } = keyring.inspect(value)
  if (status === "not-ciphertext") {
    if (!strict || value === "") return null // '' = scrub marker / empty field
    if (raw && typeof value === "string" && raw.test(value)) {
      // Legacy plaintext the app still accepts here: encrypt it.
      if (!apply) {
        tally.pending++
        tally.plaintextMigrated = (tally.plaintextMigrated || 0) + 1
        return value
      }
      const next = keyring.encrypt(value)
      const check = keyring.inspect(next)
      if (check.status !== "current" || check.plaintext !== value) {
        throw new Error(`plaintext migration verification failed at ${where}`)
      }
      tally.pending++
      tally.plaintextMigrated = (tally.plaintextMigrated || 0) + 1
      return next
    }
    // Plaintext or a damaged ciphertext where only ciphertext is valid.
    tally.undecryptable.push(where)
    return null
  }
  if (status === "undecryptable") {
    // Includes a value under the current key id that fails authentication
    // (tampered, or written by a different key): never counted as current.
    tally.undecryptable.push(where)
    return null
  }
  if (status === "current") {
    tally.current++
    return null
  }
  if (!apply) {
    tally.pending++
    return value
  }
  const next = keyring.encrypt(plaintext)
  const check = keyring.inspect(next)
  if (check.status !== "current" || check.plaintext !== plaintext) {
    throw new Error(`re-encryption verification failed at ${where}`)
  }
  tally.pending++
  return next
}

/** The secretPaths entry matching `keys` (array indices as "*"), or null. */
function secretPathFor(secretPaths, keys) {
  return (
    (secretPaths || []).find(
      ({ path }) => path.length === keys.length && path.every((p, i) => p === keys[i]),
    ) || null
  )
}

/**
 * Recursively rewrite ciphertext strings inside a JSON value; known secret
 * paths are held to the strict rule (see header).
 */
function rewriteJson(
  node,
  keyring,
  tally,
  where,
  secretPaths = [],
  keys = [],
  apply = true,
) {
  const secret = secretPathFor(secretPaths, keys)
  if (secret && node !== null && node !== undefined && typeof node !== "string") {
    tally.undecryptable.push(where) // a secret path holding a non-string
    return { value: node, changed: false }
  }
  if (typeof node === "string") {
    const next = rewrite(
      node,
      keyring,
      tally,
      where,
      secret ? { strict: true, raw: secret.raw, apply } : { apply },
    )
    return next === null
      ? { value: node, changed: false }
      : { value: next, changed: true }
  }
  if (Array.isArray(node)) {
    let changed = false
    const value = node.map((item, i) => {
      const r = rewriteJson(
        item,
        keyring,
        tally,
        `${where}[${i}]`,
        secretPaths,
        [...keys, "*"],
        apply,
      )
      changed = changed || r.changed
      return r.value
    })
    return { value, changed }
  }
  if (node && typeof node === "object") {
    let changed = false
    const value = {}
    for (const [k, v] of Object.entries(node)) {
      const r = rewriteJson(
        v,
        keyring,
        tally,
        `${where}.${k}`,
        secretPaths,
        [...keys, k],
        apply,
      )
      changed = changed || r.changed
      value[k] = r.value
    }
    return { value, changed }
  }
  return { value: node, changed: false }
}

async function tableExists(pool, table) {
  const { rows } = await pool.query("SELECT to_regclass($1) IS NOT NULL AS ok", [
    `public.${table}`,
  ])
  return rows[0]?.ok === true
}

/** Keyset pagination over `table` by `key` (text comparison works for every PK here). */
async function* rows(pool, table, key, select) {
  let after = null
  for (;;) {
    const { rows: batch } = await pool.query(
      `SELECT ${key} AS pk, ${select} FROM ${table}
       WHERE ($1::text IS NULL OR ${key}::text > $1::text)
       ORDER BY ${key}::text
       LIMIT ${BATCH}`,
      [after],
    )
    for (const row of batch) yield row
    if (batch.length < BATCH) return
    after = String(batch[batch.length - 1].pk)
  }
}

/**
 * Re-encrypt everything that needs it. Dependencies injected for tests.
 * @returns {Promise<{current:number,pending:number,rewritten:number,conflicts:number,undecryptable:string[],targets:object[]}>}
 */
async function reencryptSecrets({
  pool,
  keyring = envKeyring(),
  apply = false,
  log = console.log,
}) {
  if (!keyring.currentKeyId()) throw new Error("ENCRYPTION_KEY is required")
  if (apply && keyring.writeFormat() !== "v2") {
    throw new Error(
      "--apply requires ENCRYPTION_WRITE_FORMAT=v2 (in the rollback-safe phase, rewriting to v2 would strand data if the image were rolled back)",
    )
  }
  const total = { current: 0, pending: 0, rewritten: 0, conflicts: 0, undecryptable: [] }
  const targets = []

  for (const { table, key, columns } of COLUMN_TARGETS) {
    if (!(await tableExists(pool, table))) continue
    for (const column of columns) {
      const tally = {
        current: 0,
        pending: 0,
        rewritten: 0,
        conflicts: 0,
        undecryptable: [],
      }
      for await (const row of rows(pool, table, key, `${column} AS value`)) {
        const next = rewrite(row.value, keyring, tally, `${table}[${row.pk}].${column}`, {
          strict: true,
          apply,
        })
        if (next === null || !apply) continue
        const res = await pool.query(
          `UPDATE ${table} SET ${column} = $3 WHERE ${key}::text = $1 AND ${column} = $2`,
          [String(row.pk), row.value, next],
        )
        if (res.rowCount === 1) tally.rewritten++
        else tally.conflicts++
      }
      targets.push({ target: `${table}.${column}`, ...tally })
    }
  }

  for (const { table, key, column, secretPaths } of JSON_TARGETS) {
    if (!(await tableExists(pool, table))) continue
    const tally = {
      current: 0,
      pending: 0,
      rewritten: 0,
      conflicts: 0,
      undecryptable: [],
    }
    for await (const row of rows(pool, table, key, `${column} AS value`)) {
      if (row.value === null || row.value === undefined) continue
      const before = tally.pending
      const r = rewriteJson(
        row.value,
        keyring,
        tally,
        `${table}[${row.pk}].${column}`,
        secretPaths,
        [],
        apply,
      )
      const values = tally.pending - before // counts are per secret, not per row
      if (!r.changed || !apply) continue
      const res = await pool.query(
        `UPDATE ${table} SET ${column} = $3::jsonb
         WHERE ${key}::text = $1 AND ${column} = $2::jsonb`,
        [String(row.pk), JSON.stringify(row.value), JSON.stringify(r.value)],
      )
      if (res.rowCount === 1) tally.rewritten += values
      else tally.conflicts += values
    }
    targets.push({ target: `${table}.${column}`, ...tally })
  }

  for (const t of targets) {
    total.current += t.current
    total.pending += t.pending
    total.rewritten += t.rewritten
    total.conflicts += t.conflicts
    total.undecryptable.push(...t.undecryptable)
    if (t.current || t.pending || t.undecryptable.length) {
      log(
        `${t.target}: current=${t.current} ${apply ? "rewritten" : "would rewrite"}=${apply ? t.rewritten : t.pending}` +
          (t.conflicts ? ` conflicts=${t.conflicts}` : "") +
          (t.undecryptable.length ? ` undecryptable=${t.undecryptable.length}` : ""),
      )
    }
  }
  for (const where of total.undecryptable)
    log(`[undecryptable] ${where} — left untouched`)
  return { ...total, targets }
}

function parseArgs(argv) {
  const at = argv.indexOf("--expect-key-id")
  const expectKeyId = at === -1 ? null : argv[at + 1] || ""
  if (at !== -1 && !/^[0-9a-f]{16}$/.test(expectKeyId)) {
    throw new Error("--expect-key-id needs a 16-hex-character key id")
  }
  return {
    apply: argv.includes("--apply"),
    check: argv.includes("--check"),
    keyIdOfStdin: argv.includes("--key-id-of-stdin"),
    expectKeyId,
    help: argv.includes("--help") || argv.includes("-h"),
  }
}

/** One line describing the key configuration this process runs with. */
function describeKeys(keyring) {
  const { current, previous } = keyring.configuredKeyIds()
  return `Keys: current=${current} previous=[${previous.join(",")}] writeFormat=${keyring.writeFormat()}`
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8").trim()
}

function createPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return new Pool({
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    database: process.env.POSTGRES_DB || "blinkpos",
    user: process.env.POSTGRES_USER || "blinkpos",
    password: process.env.POSTGRES_PASSWORD,
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      "Usage: node scripts/reencrypt-secrets.js [--apply | --check] [--expect-key-id <kid>]\n" +
        "       node scripts/reencrypt-secrets.js --key-id-of-stdin",
    )
    return 0
  }
  if (args.keyIdOfStdin) {
    const key = await readStdin()
    if (!key) throw new Error("no key on stdin")
    console.log(keyId(key))
    return 0
  }
  if (args.apply && args.check) throw new Error("--apply and --check are exclusive")
  const keyring = envKeyring()
  console.log(describeKeys(keyring))
  if (args.expectKeyId && keyring.currentKeyId() !== args.expectKeyId) {
    throw new Error(
      `this process runs with current key id ${keyring.currentKeyId()}, expected ${args.expectKeyId}: ` +
        "the pod has not restarted onto the new key yet (wait for the rollout)",
    )
  }
  if (args.check && keyring.writeFormat() !== "v2") {
    throw new Error(
      "--check requires ENCRYPTION_WRITE_FORMAT=v2: in the rollback-safe phase values are still written in the legacy format",
    )
  }
  const pool = createPool()
  try {
    console.log(
      `Current key id: ${keyring.currentKeyId()} (${args.apply ? "apply" : args.check ? "check" : "dry run"})`,
    )
    const r = await reencryptSecrets({ pool, keyring, apply: args.apply })
    console.log(
      `\nSummary: current=${r.current} ${args.apply ? `rewritten=${r.rewritten}` : `pending=${r.pending}`}` +
        ` conflicts=${r.conflicts} undecryptable=${r.undecryptable.length}`,
    )
    if (args.check) {
      const ok = r.pending === 0 && r.undecryptable.length === 0
      console.log(ok ? "CHECK OK: every secret is under the current key" : "CHECK FAILED")
      return ok ? 0 : 1
    }
    if (args.apply && r.conflicts > 0) console.log("Some rows changed meanwhile: re-run.")
    return r.undecryptable.length > 0 ? 1 : 0
  } finally {
    await pool.end()
  }
}

module.exports = {
  COLUMN_TARGETS,
  JSON_TARGETS,
  reencryptSecrets,
  rewriteJson,
  parseArgs,
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error("Re-encryption failed:", err.message)
      process.exitCode = 1
    },
  )
}

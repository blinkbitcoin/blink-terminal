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
 * Usage:
 *   node scripts/reencrypt-secrets.js            dry run: report only
 *   node scripts/reencrypt-secrets.js --apply    rewrite
 *   node scripts/reencrypt-secrets.js --check    exit 1 unless every value is
 *                                                under the current key
 *
 * Requires ENCRYPTION_KEY (and ENCRYPTION_KEY_PREVIOUS while rotating), and
 * DATABASE_URL or POSTGRES_* for the database.
 */

const { Pool } = require("pg")

const { envKeyring } = require("../lib/crypto/keyring")

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
const JSON_TARGETS = [
  { table: "user_records", key: "user_hash", column: "data" },
  { table: "payment_splits", key: "id", column: "metadata" },
]

const BATCH = 500

/**
 * Rewrite `value` if it needs it. Returns the new ciphertext, or null when
 * nothing should change; records the outcome in `tally`.
 */
function rewrite(value, keyring, tally, where) {
  const { status, plaintext } = keyring.inspect(value)
  if (status === "not-ciphertext") return null
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
  const next = keyring.encrypt(plaintext)
  const check = keyring.inspect(next)
  if (check.status !== "current" || check.plaintext !== plaintext) {
    throw new Error(`re-encryption verification failed at ${where}`)
  }
  tally.pending++
  return next
}

/** Recursively rewrite ciphertext strings inside a JSON value. */
function rewriteJson(node, keyring, tally, where) {
  if (typeof node === "string") {
    const next = rewrite(node, keyring, tally, where)
    return next === null
      ? { value: node, changed: false }
      : { value: next, changed: true }
  }
  if (Array.isArray(node)) {
    let changed = false
    const value = node.map((item, i) => {
      const r = rewriteJson(item, keyring, tally, `${where}[${i}]`)
      changed = changed || r.changed
      return r.value
    })
    return { value, changed }
  }
  if (node && typeof node === "object") {
    let changed = false
    const value = {}
    for (const [k, v] of Object.entries(node)) {
      const r = rewriteJson(v, keyring, tally, `${where}.${k}`)
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
        const next = rewrite(row.value, keyring, tally, `${table}[${row.pk}].${column}`)
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

  for (const { table, key, column } of JSON_TARGETS) {
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
      const r = rewriteJson(row.value, keyring, tally, `${table}[${row.pk}].${column}`)
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
  return {
    apply: argv.includes("--apply"),
    check: argv.includes("--check"),
    help: argv.includes("--help") || argv.includes("-h"),
  }
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
    console.log("Usage: node scripts/reencrypt-secrets.js [--apply | --check]")
    return 0
  }
  if (args.apply && args.check) throw new Error("--apply and --check are exclusive")
  const keyring = envKeyring()
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

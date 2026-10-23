/** @jest-environment node */

/**
 * Real-Postgres probe for the consumed-payment-hash race (blink-wip#1646).
 *
 * Migration 028's BEFORE INSERT trigger rejects a boltcard_pending_withdrawals
 * insert whose hash is already consumed while its withdrawal row is gone
 * (wiped / re-registered card). Migration 030 makes that rejection raise
 * SQLSTATE BC409 so claimAndDeductWithdrawal() can answer "spent" instead of
 * letting a generic error become an HTTP 500. Mocked clients cannot prove the
 * error code Postgres actually raises, so the exact trigger function from the
 * migration file and the store's exact claim insert run on PGlite.
 */

import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"

jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { encryptApiKey: (k: string) => k, decryptApiKey: (k: string) => k },
}))
jest.mock("../../lib/db", () => ({
  getSharedPool: () => ({ query: jest.fn() }),
  getClient: async () => ({ query: jest.fn(), release: () => undefined }),
}))

import {
  CLAIM_WITHDRAWAL_INSERT_SQL,
  CONSUMED_HASH_SQLSTATE,
} from "../../lib/boltcard/store"

const NOW = Date.now()
const HASH = "ab".repeat(32)

/** Migrations 016/025–028 for the columns the claim insert touches. */
const DDL = [
  `CREATE TABLE boltcards (id VARCHAR(32) PRIMARY KEY)`,
  `CREATE TABLE boltcard_pending_withdrawals (
     payment_hash VARCHAR(64) PRIMARY KEY,
     card_id VARCHAR(32) NOT NULL REFERENCES boltcards(id) ON DELETE CASCADE,
     amount BIGINT NOT NULL CHECK (amount > 0),
     balance_after BIGINT NOT NULL,
     created_at BIGINT NOT NULL,
     resolved_at BIGINT,
     outcome TEXT,
     daily_window_reset_at BIGINT,
     kind TEXT NOT NULL DEFAULT 'PENDING',
     attempt BIGINT NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE boltcard_consumed_payment_hashes (
     payment_hash VARCHAR(64) PRIMARY KEY,
     consumed_at BIGINT NOT NULL
   )`,
]

const MIGRATION_030 = fs.readFileSync(
  path.join(process.cwd(), "database/migrations/030_consumed_hash_sqlstate.sql"),
  "utf8",
)
const section = (name: string): string => {
  const begin = `-- MIGRATION-030:${name}:BEGIN`
  const end = `-- MIGRATION-030:${name}:END`
  const start = MIGRATION_030.indexOf(begin)
  const stop = MIGRATION_030.indexOf(end)
  if (start === -1 || stop === -1) throw new Error(`section not found: ${name}`)
  return MIGRATION_030.slice(start + begin.length, stop).trim()
}
const RETAIN_FUNCTION_SQL = section("RETAIN-FUNCTION")
const TRIGGER_SQL = `CREATE TRIGGER trg_boltcard_pending_withdrawals_retain_hash
  BEFORE INSERT ON boltcard_pending_withdrawals
  FOR EACH ROW EXECUTE FUNCTION retain_consumed_payment_hash()`

const run = (seeds: Array<[string, unknown[]]>, query: string, params: unknown[]) => {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "scripts", "pglite-sql-probe.mjs")],
    {
      env: {
        ...process.env,
        PROBE_PROGRAM: JSON.stringify({
          ddl: [...DDL, RETAIN_FUNCTION_SQL, TRIGGER_SQL],
          seeds,
          query,
          params,
        }),
      },
      encoding: "utf8",
      timeout: 60000,
    },
  )
  if (result.error) throw result.error
  return result
}

const claim = (cardId = "card-b"): [string, unknown[]] => [
  CLAIM_WITHDRAWAL_INSERT_SQL,
  [HASH, cardId, 1000, NOW],
]

describe("consumed payment hash on real Postgres (PGlite)", () => {
  it("the race: tombstone present, withdrawal row gone -> SQLSTATE BC409", () => {
    // A claimed and committed on card-a, then card-a was wiped: its
    // withdrawal row cascaded away, the tombstone stayed. B (which passed the
    // application pre-check earlier) now inserts.
    const { status, stderr } = run(
      [
        ["INSERT INTO boltcards (id) VALUES ('card-a'), ('card-b')", []],
        claim("card-a"),
        ["DELETE FROM boltcards WHERE id = 'card-a'", []],
      ],
      CLAIM_WITHDRAWAL_INSERT_SQL,
      [HASH, "card-b", 1000, NOW],
    )
    expect(status).not.toBe(0)
    const error = JSON.parse(stderr) as { message: string; code: string | null }
    expect(error.code).toBe(CONSUMED_HASH_SQLSTATE)
    expect(error.message).toContain("payment hash already consumed")
  })

  it("the tombstone survives the card deletion (what makes the race possible)", () => {
    const result = run(
      [
        ["INSERT INTO boltcards (id) VALUES ('card-a')", []],
        claim("card-a"),
        ["DELETE FROM boltcards WHERE id = 'card-a'", []],
      ],
      `SELECT
         (SELECT COUNT(*)::int FROM boltcard_consumed_payment_hashes WHERE payment_hash = $1) AS tombstones,
         (SELECT COUNT(*)::int FROM boltcard_pending_withdrawals WHERE payment_hash = $1) AS withdrawals`,
      [HASH],
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).rows[0]).toEqual({ tombstones: 1, withdrawals: 0 })
  })

  it("an idempotent replay (withdrawal row still present) is not raised: ON CONFLICT, 0 rows", () => {
    const result = run(
      [["INSERT INTO boltcards (id) VALUES ('card-a')", []], claim("card-a")],
      CLAIM_WITHDRAWAL_INSERT_SQL,
      [HASH, "card-a", 1000, NOW],
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).rows).toEqual([]) // DO NOTHING -> store says "spent"
  })

  it("a fresh hash claims normally and leaves a tombstone", () => {
    const result = run(
      [["INSERT INTO boltcards (id) VALUES ('card-a')", []], claim("card-a")],
      "SELECT COUNT(*)::int AS n FROM boltcard_consumed_payment_hashes",
      [],
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).rows[0]).toEqual({ n: 1 })
  })
})

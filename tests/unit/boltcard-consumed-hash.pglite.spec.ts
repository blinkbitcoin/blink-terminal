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
  MARK_WITHDRAWAL_CHECKED_SQL,
  PENDING_WITHDRAWALS_SQL,
  STALE_WITHDRAWALS_SQL,
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
     attempt BIGINT NOT NULL DEFAULT 1,
     last_checked_at BIGINT
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

/**
 * getStaleWithdrawals (blink-wip#1619): the exact SQL on real Postgres —
 * only unresolved rows older than the cutoff, optionally scoped to card ids
 * (text[] parameter; NULL = all), oldest first.
 */
describe("stale withdrawals query (PGlite)", () => {
  const MIN = 60_000
  const row = (
    hash: string,
    cardId: string,
    createdAt: number,
    resolved = false,
  ): [string, unknown[]] => [
    `INSERT INTO boltcard_pending_withdrawals
       (payment_hash, card_id, amount, balance_after, created_at, kind, resolved_at)
     VALUES ($1, $2, 1000, 0, $3, 'UNKNOWN', $4)`,
    [hash, cardId, createdAt, resolved ? createdAt + 1000 : null],
  ]
  const seeds: Array<[string, unknown[]]> = [
    ["INSERT INTO boltcards (id) VALUES ('card-a'), ('card-b')", []],
    row("01".repeat(32), "card-a", NOW - 40 * MIN), // stale
    row("02".repeat(32), "card-b", NOW - 20 * MIN), // stale, other card
    row("03".repeat(32), "card-a", NOW - 5 * MIN), // young
    row("04".repeat(32), "card-a", NOW - 50 * MIN, true), // old but resolved
  ]

  it("returns unresolved rows older than the cutoff, oldest first", () => {
    const result = run(seeds, STALE_WITHDRAWALS_SQL, [NOW - 15 * MIN, null])
    expect(result.status).toBe(0)
    expect(
      JSON.parse(result.stdout).rows.map((r: { payment_hash: string }) => r.payment_hash),
    ).toEqual(["01".repeat(32), "02".repeat(32)])
  })

  it("cutoff 0-age (now) lists everything in flight; card scoping applies", () => {
    const all = run(seeds, STALE_WITHDRAWALS_SQL, [NOW + 1, null])
    expect(JSON.parse(all.stdout).rows).toHaveLength(3)
    const scoped = run(seeds, STALE_WITHDRAWALS_SQL, [NOW + 1, ["card-a"]])
    expect(
      JSON.parse(scoped.stdout).rows.map((r: { payment_hash: string }) => r.payment_hash),
    ).toEqual(["01".repeat(32), "03".repeat(32)])
  })
})

/**
 * Fair batched selection (migration 031; blink-wip#1619 review): with a
 * per-pass cap, ordering by created_at alone re-selects a stuck oldest prefix
 * forever. The exact selection and stamp SQL on real Postgres, batch = 2:
 * A and B (oldest) stay unresolved across passes; C must still be selected.
 */
describe("fair batched reconciliation order (PGlite)", () => {
  const MIN = 60_000
  const unresolved = (hash: string, createdAt: number): [string, unknown[]] => [
    `INSERT INTO boltcard_pending_withdrawals
       (payment_hash, card_id, amount, balance_after, created_at, kind)
     VALUES ($1, 'card-a', 1000, 0, $2, 'UNKNOWN')`,
    [hash, createdAt],
  ]
  const A = "0a".repeat(32)
  const B = "0b".repeat(32)
  const C = "0c".repeat(32)
  const seeds: Array<[string, unknown[]]> = [
    ["INSERT INTO boltcards (id) VALUES ('card-a')", []],
    unresolved(A, NOW - 30 * MIN),
    unresolved(B, NOW - 20 * MIN),
    unresolved(C, NOW - 10 * MIN), // newest; terminal at Blink, needs its restore
  ]
  const stamp = (hash: string, at: number): [string, unknown[]] => [
    MARK_WITHDRAWAL_CHECKED_SQL,
    [hash, at],
  ]
  const selected = (extra: Array<[string, unknown[]]>) => {
    const result = run([...seeds, ...extra], PENDING_WITHDRAWALS_SQL, [null, 2])
    expect(result.status).toBe(0)
    return JSON.parse(result.stdout).rows.map(
      (r: { payment_hash: string }) => r.payment_hash,
    )
  }

  it("pass 1 takes the never-checked oldest two", () => {
    expect(selected([])).toEqual([A, B])
  })

  it("pass 2 reaches C even though A and B are still unresolved", () => {
    // Pass 1 examined A and B (stamped before their lookups); nothing resolved.
    expect(selected([stamp(A, NOW), stamp(B, NOW + 1)])).toEqual([C, A])
  })

  it("pass 3 rotates: least recently checked first", () => {
    expect(selected([stamp(A, NOW), stamp(B, NOW + 1), stamp(C, NOW + 2)])).toEqual([
      A,
      B,
    ])
  })

  it("the whole backlog is covered within ceil(backlog / batch) passes", () => {
    // Simulate passes: select 2, stamp them, repeat; every row seen by pass 2.
    const seen = new Set<string>()
    let stamps: Array<[string, unknown[]]> = []
    for (let pass = 0; pass < 2; pass++) {
      const batch = selected(stamps)
      for (const h of batch) seen.add(h)
      stamps = [
        ...stamps,
        ...batch.map((h: string, i: number) => stamp(h, NOW + pass * 10 + i)),
      ]
    }
    expect([...seen].sort()).toEqual([A, B, C].sort())
  })

  it("the stamp is a no-op once resolved", () => {
    const result = run(
      [
        ...seeds,
        [
          "UPDATE boltcard_pending_withdrawals SET resolved_at = $1 WHERE payment_hash = $2",
          [NOW, A],
        ],
        stamp(A, NOW + 5),
      ],
      "SELECT last_checked_at FROM boltcard_pending_withdrawals WHERE payment_hash = $1",
      [A],
    )
    expect(JSON.parse(result.stdout).rows[0]).toEqual({ last_checked_at: null })
  })
})

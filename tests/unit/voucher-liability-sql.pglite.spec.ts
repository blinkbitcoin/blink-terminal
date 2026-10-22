/** @jest-environment node */

/**
 * Real-Postgres probe for the voucher liability aggregate (PR #94 review):
 * the store's unit tests mock client.query, which cannot catch PostgreSQL
 * parameter-type inference — an uncast fractional rate made
 * `amount_sats * $3` fail with `invalid input syntax for type bigint`.
 *
 * Jest's CJS runtime cannot run PGlite (dynamic import callback), so the
 * exact SQL constants the store executes are passed to a plain-Node PGlite
 * child process (scripts/pglite-sql-probe.mjs) — same SQL, real Postgres.
 */

import { spawnSync } from "child_process"
import path from "path"

// voucher-store imports AuthManager at module scope (JWT_SECRET guard).
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { encryptApiKey: (k: string) => k, decryptApiKey: (k: string) => k },
}))
// The store's pool is never touched here — only the exported SQL constants.
jest.mock("../../lib/db", () => ({ getSharedPool: () => ({ query: jest.fn() }) }))

import {
  ACTIVE_LIABILITY_SUM_SQL_BTC,
  ACTIVE_LIABILITY_SUM_SQL_USD,
} from "../../lib/voucher-store"

const NOW = Date.now()
const DDL = `CREATE TABLE vouchers (
  id TEXT PRIMARY KEY,
  amount_sats BIGINT NOT NULL,
  usd_amount_cents INTEGER,
  wallet_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at BIGINT NOT NULL
)`

interface ProbeResult {
  ok: boolean
  rows: Array<{ total: string }>
}

const probe = (
  seeds: Array<[string, unknown[]]>,
  query: string,
  params: unknown[],
): ProbeResult => {
  const program = { ddl: [DDL], seeds, query, params }
  const run = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "scripts", "pglite-sql-probe.mjs")],
    {
      env: { ...process.env, PROBE_PROGRAM: JSON.stringify(program) },
      encoding: "utf8",
      timeout: 60000,
    },
  )
  if (run.error) throw run.error
  if (run.status !== 0) {
    throw new Error(`PGlite probe failed: ${run.stderr}`)
  }
  return JSON.parse(run.stdout) as ProbeResult
}

const seedRow = (
  id: string,
  walletId: string,
  sats: number,
  cents: number | null,
  overrides: { status?: string; expiresAt?: number } = {},
): [string, unknown[]] => [
  `INSERT INTO vouchers (id, amount_sats, usd_amount_cents, wallet_id, status, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [
    id,
    sats,
    cents,
    walletId,
    overrides.status ?? "ACTIVE",
    overrides.expiresAt ?? NOW + 3_600_000,
  ],
]

const sumUsd = (seeds: Array<[string, unknown[]]>, rate: number): number => {
  const result = probe(seeds, ACTIVE_LIABILITY_SUM_SQL_USD, ["w1", NOW, rate])
  return Math.ceil(Number(result.rows[0]?.total ?? 0))
}

describe("ACTIVE_LIABILITY_SUM_SQL_USD against real Postgres (PGlite)", () => {
  it("accepts a fractional rate (the reported bigint inference failure)", () => {
    // 2060 sats at 0.05 cents/sat = 103 cents, above the 100 stored cents
    expect(sumUsd([seedRow("v1", "w1", 2060, 100)], 0.05)).toBe(103)
  })

  it("uses GREATEST in both directions", () => {
    expect(
      sumUsd(
        [
          seedRow("v1", "w1", 2060, 100), // ceil(103) > 100 -> 103
          seedRow("v2", "w1", 100, 150), // ceil(5) < 150 -> 150
        ],
        0.05,
      ),
    ).toBe(253)
  })

  it("excludes expired, non-ACTIVE and other-wallet rows", () => {
    expect(
      sumUsd(
        [
          seedRow("v1", "w1", 2060, 100),
          seedRow("v2", "w1", 2060, 100, { expiresAt: NOW - 1000 }),
          seedRow("v3", "w1", 2060, 100, { status: "PAID" }),
          seedRow("v4", "w2", 2060, 100),
        ],
        0.05,
      ),
    ).toBe(103)
  })

  it("counts CLAIMED (in-flight redemption) vouchers as liabilities", () => {
    // claimVoucher sets CLAIMED before the payment round trip; the voucher
    // must stay in the liability set until settlement (blink-wip#1665).
    expect(
      sumUsd(
        [
          seedRow("v1", "w1", 2060, 100, { status: "CLAIMED" }),
          seedRow("v2", "w1", 2060, 100),
        ],
        0.05,
      ),
    ).toBe(206)
  })

  it("drops liabilities only on settlement outcomes (PAID/CANCELLED)", () => {
    expect(
      sumUsd(
        [
          seedRow("v1", "w1", 2060, 100, { status: "PAID" }),
          seedRow("v2", "w1", 2060, 100, { status: "CANCELLED" }),
          seedRow("v3", "w1", 2060, 100, { status: "CLAIMED" }),
        ],
        0.05,
      ),
    ).toBe(103)
  })

  it("treats missing usd_amount_cents as 0 and still re-rates from sats", () => {
    expect(sumUsd([seedRow("v1", "w1", 2060, null)], 0.05)).toBe(103)
  })

  it("an empty wallet sums to zero", () => {
    expect(sumUsd([], 0.05)).toBe(0)
  })
})

describe("ACTIVE_LIABILITY_SUM_SQL_BTC against real Postgres (PGlite)", () => {
  it("sums plain sats for the wallet, including in-flight CLAIMED", () => {
    const result = probe(
      [
        seedRow("v1", "w1", 600, null),
        seedRow("v2", "w1", 400, null, { status: "CLAIMED" }),
        seedRow("v3", "w2", 9999, null),
      ],
      ACTIVE_LIABILITY_SUM_SQL_BTC,
      ["w1", NOW],
    )
    expect(parseInt(String(result.rows[0]?.total ?? "0"), 10)).toBe(1000)
  })
})

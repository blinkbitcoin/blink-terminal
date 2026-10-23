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
 *
 * The base DDL mirrors migration 008 (including valid_voucher_status) and
 * every probe applies migration 029's exported ALTER statements, so the
 * lifecycle runs against production-faithful constraints.
 */

import { spawnSync } from "child_process"
import fs from "fs"
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
  CLAIM_VOUCHER_SQL,
  LOCK_TIMEOUT_SQL,
  MARK_VOUCHER_PAID_SQL,
  WALLET_LOCK_SQL,
} from "../../lib/voucher-store"

const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Migration 008's schema for the columns these probes touch, including the
 * status constraint that predates PAID.
 */
const DDL = `CREATE TABLE vouchers (
  id TEXT PRIMARY KEY,
  amount_sats BIGINT NOT NULL CHECK (amount_sats > 0),
  usd_amount_cents INTEGER,
  wallet_id TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  expires_at BIGINT NOT NULL,
  claimed BOOLEAN NOT NULL DEFAULT false,
  claimed_at BIGINT,
  cancelled_at BIGINT,
  wallet_currency VARCHAR(3) NOT NULL DEFAULT 'BTC',
  api_key_encrypted TEXT NOT NULL DEFAULT 'enc',
  environment VARCHAR(20) DEFAULT 'production',
  display_amount VARCHAR(50),
  display_currency VARCHAR(10),
  commission_percent DECIMAL(5, 2) DEFAULT 0,
  CONSTRAINT valid_voucher_status CHECK (status IN ('ACTIVE', 'CLAIMED', 'CANCELLED', 'EXPIRED'))
)`

const MIGRATION_029 = fs.readFileSync(
  path.join(process.cwd(), "database/migrations/029_voucher_paid_status.sql"),
  "utf8",
)

/** Slice one marked section out of migration 029 (the exact text it runs). */
const migrationSection = (name: string): string => {
  const begin = `-- MIGRATION-029:${name}:BEGIN`
  const end = `-- MIGRATION-029:${name}:END`
  const start = MIGRATION_029.indexOf(begin)
  const stop = MIGRATION_029.indexOf(end)
  if (start === -1 || stop === -1) {
    throw new Error(`Migration 029 section not found: ${name}`)
  }
  return MIGRATION_029.slice(start + begin.length, stop).trim()
}

const STATUS_CONSTRAINT_STATEMENTS = migrationSection("STATUS-CONSTRAINT")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean)
const CLEANUP_FUNCTION_SQL = migrationSection("CLEANUP-FUNCTION")

interface ProbeResult {
  ok: boolean
  rows: Array<Record<string, unknown>>
}

interface ProbeOptions {
  /** Apply migration 029's status constraint (default true). */
  applyConstraint?: boolean
  extraDdl?: string[]
}

const runProgram = (
  program: unknown,
): { status: number | null; stdout: string; stderr: string } => {
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
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

const buildProgram = (
  seeds: Array<[string, unknown[]]>,
  query: string,
  params: unknown[],
  options: ProbeOptions = {},
): unknown => ({
  ddl: [
    DDL,
    ...(options.applyConstraint === false ? [] : STATUS_CONSTRAINT_STATEMENTS),
    ...(options.extraDdl ?? []),
  ],
  seeds,
  query,
  params,
})

/** Run a probe expected to succeed; returns parsed rows. */
const probe = (
  seeds: Array<[string, unknown[]]>,
  query: string,
  params: unknown[],
  options: ProbeOptions = {},
): ProbeResult => {
  const program = buildProgram(seeds, query, params, options)
  const { status, stdout, stderr } = runProgram(program)
  if (status !== 0) {
    throw new Error(`PGlite probe failed: ${stderr}`)
  }
  return JSON.parse(stdout) as ProbeResult
}

/** Run a probe expected to fail; returns the Postgres error text. */
const probeFailure = (
  seeds: Array<[string, unknown[]]>,
  query: string,
  params: unknown[],
  options: ProbeOptions = {},
): string => {
  const { status, stderr } = runProgram(buildProgram(seeds, query, params, options))
  expect(status).not.toBe(0)
  return stderr
}

const seedRow = (
  id: string,
  walletId: string,
  sats: number,
  cents: number | null,
  overrides: {
    status?: string
    expiresAt?: number
    claimed?: boolean
    claimedAt?: number | null
  } = {},
): [string, unknown[]] => [
  `INSERT INTO vouchers (id, amount_sats, usd_amount_cents, wallet_id, status, expires_at, claimed, claimed_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [
    id,
    sats,
    cents,
    walletId,
    overrides.status ?? "ACTIVE",
    overrides.expiresAt ?? NOW + 3_600_000,
    overrides.claimed ?? false,
    overrides.claimedAt ?? null,
  ],
]

const sumUsd = (seeds: Array<[string, unknown[]]>, rate: number): number => {
  const result = probe(seeds, ACTIVE_LIABILITY_SUM_SQL_USD, ["w1", NOW, rate])
  return Math.ceil(Number(result.rows[0]?.total ?? 0))
}

const sumBtc = (seeds: Array<[string, unknown[]]>): number => {
  const result = probe(seeds, ACTIVE_LIABILITY_SUM_SQL_BTC, ["w1", NOW])
  return parseInt(String(result.rows[0]?.total ?? "0"), 10)
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

  it("excludes expired ACTIVE, terminal and other-wallet rows", () => {
    expect(
      sumUsd(
        [
          seedRow("v1", "w1", 2060, 100),
          seedRow("v2", "w1", 2060, 100, { expiresAt: NOW - 1000 }), // expired ACTIVE
          seedRow("v3", "w1", 2060, 100, { status: "PAID" }),
          seedRow("v4", "w2", 2060, 100),
        ],
        0.05,
      ),
    ).toBe(103)
  })

  it("keeps expired CLAIMED counted (expiry only ends ACTIVE)", () => {
    // A voucher claimed just before expiry may still settle (PENDING/unknown),
    // so its liability must not disappear when expires_at passes.
    expect(
      sumUsd(
        [
          seedRow("v1", "w1", 2060, 100, {
            status: "CLAIMED",
            claimed: true,
            expiresAt: NOW - 1000,
          }),
          seedRow("v2", "w1", 2060, 100, { expiresAt: NOW - 1000 }), // expired ACTIVE
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
          seedRow("v1", "w1", 2060, 100, { status: "CLAIMED", claimed: true }),
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
          seedRow("v3", "w1", 2060, 100, { status: "CLAIMED", claimed: true }),
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
    expect(
      sumBtc([
        seedRow("v1", "w1", 600, null),
        seedRow("v2", "w1", 400, null, { status: "CLAIMED", claimed: true }),
        seedRow("v3", "w2", 9999, null),
      ]),
    ).toBe(1000)
  })

  it("keeps expired CLAIMED counted and excludes expired ACTIVE", () => {
    expect(
      sumBtc([
        seedRow("v1", "w1", 600, null, {
          status: "CLAIMED",
          claimed: true,
          expiresAt: NOW - DAY_MS,
        }),
        seedRow("v2", "w1", 400, null, { expiresAt: NOW - 1000 }),
      ]),
    ).toBe(600)
  })
})

/**
 * Full redemption lifecycle through the exact production transition
 * statements: ACTIVE -> CLAIMED (counted) -> PAID (exits the aggregate).
 */
describe("voucher lifecycle vs the liability aggregate (PGlite)", () => {
  it("a settled redemption leaves the aggregate; in-flight stays counted", () => {
    const seeds = [seedRow("v1", "w1", 500, null)]
    // ACTIVE counts
    expect(sumUsd(seeds, 0.05)).toBe(25)

    // Claim (payment in flight) — still counted
    const claimed = probe(seeds, CLAIM_VOUCHER_SQL, ["v1", NOW])
    expect(claimed.rows).toEqual([{ id: "v1" }])
    // Claim then PAID in one probe run: settled — excluded
    const lifecycleSeeds = [
      ...seeds,
      [CLAIM_VOUCHER_SQL, ["v1", NOW]] as [string, unknown[]],
      [MARK_VOUCHER_PAID_SQL, ["v1"]] as [string, unknown[]],
    ]
    expect(sumUsd(lifecycleSeeds, 0.05)).toBe(0)
  })

  it("an expired CLAIMED redemption stays counted until PAID", () => {
    const seeds = [
      seedRow("v1", "w1", 500, null, {
        status: "CLAIMED",
        claimed: true,
        claimedAt: NOW - DAY_MS,
        expiresAt: NOW - 1000,
      }),
    ]
    expect(sumUsd(seeds, 0.05)).toBe(25)
    const paidSeeds = [...seeds, [MARK_VOUCHER_PAID_SQL, ["v1"]] as [string, unknown[]]]
    expect(sumUsd(paidSeeds, 0.05)).toBe(0)
  })

  it("mark-paid does not transition a non-CLAIMED voucher", () => {
    const result = probe([seedRow("v1", "w1", 500, null)], MARK_VOUCHER_PAID_SQL, ["v1"])
    expect(result.rows).toEqual([]) // RETURNING produced nothing: still ACTIVE
    // And it remains a liability
    expect(sumUsd([seedRow("v1", "w1", 500, null)], 0.05)).toBe(25)
  })

  it("the reviewer's scenario: settled vouchers restore issuance capacity", () => {
    // Two 500-sat vouchers redeemed from a 2,000-sat wallet: once settled,
    // the aggregate must drop to 0 (Blink reports the debited balance).
    const lifecycleSeeds = [
      seedRow("v1", "w1", 500, null),
      seedRow("v2", "w1", 500, null),
      [CLAIM_VOUCHER_SQL, ["v1", NOW]] as [string, unknown[]],
      [CLAIM_VOUCHER_SQL, ["v2", NOW]] as [string, unknown[]],
      [MARK_VOUCHER_PAID_SQL, ["v1"]] as [string, unknown[]],
      [MARK_VOUCHER_PAID_SQL, ["v2"]] as [string, unknown[]],
    ]
    expect(sumUsd(lifecycleSeeds, 0.05)).toBe(0)
    // Mid-lifecycle: both claimed, both counted
    const claimedSeeds = [
      seedRow("v1", "w1", 500, null),
      seedRow("v2", "w1", 500, null),
      [CLAIM_VOUCHER_SQL, ["v1", NOW]] as [string, unknown[]],
      [CLAIM_VOUCHER_SQL, ["v2", NOW]] as [string, unknown[]],
    ]
    expect(sumUsd(claimedSeeds, 0.05)).toBe(50)
  })

  it("settlement fails against migration 008's constraint without migration 029", () => {
    // Regression for the review blocker: PAID was not in valid_voucher_status,
    // so every production settlement update raised SQLSTATE 23514 and settled
    // vouchers stayed CLAIMED (counted) until expiry.
    const error = probeFailure(
      [seedRow("v1", "w1", 500, null, { status: "CLAIMED", claimed: true })],
      MARK_VOUCHER_PAID_SQL,
      ["v1"],
      { applyConstraint: false },
    )
    expect(error).toContain("valid_voucher_status")
  })

  it("migration 029 allows CLAIMED -> PAID against the real constraint", () => {
    const result = probe(
      [seedRow("v1", "w1", 500, null, { status: "CLAIMED", claimed: true })],
      MARK_VOUCHER_PAID_SQL,
      ["v1"],
    )
    expect(result.rows).toEqual([{ id: "v1" }])
  })
})

/**
 * Migration 029's cleanup_old_vouchers(): PAID follows the 30-day retention
 * policy, CLAIMED is never aged out (an unresolved liability that only
 * reconciliation/unclaim/cancel may change), and the retention arithmetic
 * must not overflow int4.
 */
describe("migration 029 cleanup_old_vouchers (PGlite)", () => {
  const cleanupSeeds: Array<[string, unknown[]]> = [
    // Old CLAIMED (31 days): RETAINED — unresolved, reconciliation needs it.
    // Old PAID (31 days): RETAINED as competitor evidence, secret scrubbed.
    [
      `INSERT INTO vouchers (id, amount_sats, wallet_id, status, expires_at, claimed_at, claimed)
       VALUES ($1, 500, 'w1', 'CLAIMED', $2, $3, true)`,
      ["old-claimed", NOW - 32 * DAY_MS, NOW - 31 * DAY_MS],
    ],
    [
      `INSERT INTO vouchers (id, amount_sats, wallet_id, status, expires_at, claimed_at, claimed)
       VALUES ($1, 500, 'w1', 'PAID', $2, $3, true)`,
      ["old-paid", NOW - 32 * DAY_MS, NOW - 31 * DAY_MS],
    ],
    // Old cancelled row (31 days): deleted by the unchanged policy
    [
      `INSERT INTO vouchers (id, amount_sats, wallet_id, status, expires_at, cancelled_at)
       VALUES ($1, 500, 'w1', 'CANCELLED', $2, $3)`,
      ["old-cancelled", NOW - 32 * DAY_MS, NOW - 31 * DAY_MS],
    ],
    // Fresh redeemed rows: retained
    seedRow("new-claimed", "w1", 500, null, {
      status: "CLAIMED",
      claimed: true,
      claimedAt: NOW - DAY_MS,
      expiresAt: NOW - 1000, // expiry is irrelevant to retention
    }),
    seedRow("new-paid", "w1", 500, null, {
      status: "PAID",
      claimed: true,
      claimedAt: NOW - DAY_MS,
      expiresAt: NOW - 1000,
    }),
    seedRow("active", "w1", 500, null),
  ]

  it("never deletes redeemed rows; scrubs only the old PAID secret", () => {
    const result = probe(
      [...cleanupSeeds, ["SELECT cleanup_old_vouchers()", []]],
      "SELECT id, api_key_encrypted AS key FROM vouchers ORDER BY id",
      [],
      { extraDdl: [CLEANUP_FUNCTION_SQL] },
    )
    expect(result.rows).toEqual([
      { id: "active", key: "enc" },
      { id: "new-claimed", key: "enc" },
      { id: "new-paid", key: "enc" }, // fresh: secret kept
      { id: "old-claimed", key: "enc" }, // unresolved: untouched
      { id: "old-paid", key: "" }, // settled 31 days ago: secret scrubbed, row kept
      // old-cancelled: deleted (unchanged policy)
    ])
  })

  it("a legacy CLAIMED row still counts as a liability after cleanup", () => {
    // The reviewer's scenario: production applies 029, the first voucher read
    // runs lazy cleanup, and only then is the reconcile script run. The
    // 31-day-old claim must still be there — and still counted.
    const result = probe(
      [...cleanupSeeds, ["SELECT cleanup_old_vouchers()", []]],
      ACTIVE_LIABILITY_SUM_SQL_BTC,
      ["w1", NOW],
      { extraDdl: [CLEANUP_FUNCTION_SQL] },
    )
    // active (500) + new-claimed (500) + old-claimed (500); PAID rows excluded
    expect(parseInt(String(result.rows[0].total), 10)).toBe(1500)
  })
})

/**
 * Migration 029's voucher_stats view: the "claimed" bucket must count
 * CLAIMED + PAID so settled redemptions still read as redeemed.
 */
describe("migration 029 voucher_stats view (PGlite)", () => {
  it("counts CLAIMED and PAID as claimed", () => {
    const viewStart = MIGRATION_029.indexOf("CREATE OR REPLACE VIEW voucher_stats")
    const viewEnd = MIGRATION_029.indexOf("FROM vouchers;") + "FROM vouchers".length
    const viewSql = MIGRATION_029.slice(viewStart, viewEnd)

    const result = probe(
      [
        seedRow("v1", "w1", 500, null),
        seedRow("v2", "w1", 500, null, { status: "CLAIMED", claimed: true }),
        seedRow("v3", "w1", 500, null, { status: "PAID", claimed: true }),
        seedRow("v4", "w1", 500, null, { status: "CANCELLED" }),
      ],
      "SELECT active, claimed FROM voucher_stats",
      [],
      { extraDdl: [viewSql] },
    )
    expect(Number(result.rows[0].active)).toBe(1)
    expect(Number(result.rows[0].claimed)).toBe(2)
  })
})

/**
 * The whole migration file as the chart's runner applies it, on the 008-era
 * schema: every statement succeeds inside its transaction, schema_version
 * reaches 29, and the production settlement update then works.
 */
describe("migration 029 full file (PGlite)", () => {
  it("applies on the 008-era schema and enables CLAIMED -> PAID", () => {
    const { status, stdout, stderr } = runProgram({
      ddl: [
        DDL,
        `CREATE TABLE system_metrics (
           id BIGSERIAL PRIMARY KEY,
           metric_name VARCHAR(255) NOT NULL,
           metric_value DECIMAL(20, 4),
           metric_unit VARCHAR(50),
           tags JSONB
         )`,
      ],
      exec: [MIGRATION_029],
      seeds: [
        seedRow("v1", "w1", 500, null, {
          status: "CLAIMED",
          claimed: true,
          claimedAt: NOW,
        }),
        [MARK_VOUCHER_PAID_SQL, ["v1"]],
      ],
      query: `SELECT
                (SELECT status FROM vouchers WHERE id = 'v1') AS status,
                (SELECT MAX(metric_value)::int FROM system_metrics
                  WHERE metric_name = 'schema_version') AS version,
                (SELECT claimed FROM voucher_stats)::int AS claimed`,
      params: [],
    })
    if (status !== 0) throw new Error(`PGlite probe failed: ${stderr}`)
    const result = JSON.parse(stdout) as ProbeResult
    expect(result.rows[0]).toEqual({ status: "PAID", version: 29, claimed: 1 })
  })

  it("runs in a single transaction", () => {
    const statements = MIGRATION_029.replace(/^--.*$/gm, "").trim()
    expect(statements.startsWith("BEGIN;")).toBe(true)
    expect(MIGRATION_029.indexOf("COMMIT;")).toBeGreaterThan(
      MIGRATION_029.indexOf("'schema_version'"),
    )
  })
})

/**
 * The per-wallet lock statements markVoucherPaid and the locked create run
 * (BACKING INVARIANT). PGlite is single-connection, so contention cannot be
 * exercised here; this proves the exact statements are valid Postgres and
 * that the settlement transition works inside the locked transaction.
 */
describe("wallet lock statements (PGlite)", () => {
  it("lock_timeout + advisory lock + CLAIMED -> PAID run in one transaction", () => {
    const result = probe(
      [
        seedRow("v1", "w1", 500, null, {
          status: "CLAIMED",
          claimed: true,
          claimedAt: NOW,
        }),
        ["BEGIN", []],
        [LOCK_TIMEOUT_SQL, []],
        [WALLET_LOCK_SQL, ["w1"]],
        [MARK_VOUCHER_PAID_SQL, ["v1"]],
        ["COMMIT", []],
      ],
      "SELECT status FROM vouchers WHERE id = 'v1'",
      [],
    )
    expect(result.rows).toEqual([{ status: "PAID" }])
  })
})

/**
 * Cleanup + reconciliation together (the reviewer's cross-component case):
 * a settled PAID voucher is the competitor that stops its payment from being
 * credited to a stuck CLAIMED claim with the same wallet/memo/amount and an
 * overlapping window. Cleanup must therefore keep the PAID row (secret
 * scrubbed) — the control run shows that deleting it would settle the unpaid
 * claim.
 */
describe("cleanup keeps the PAID competitor reconciliation needs (PGlite + script)", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { reconcileClaimedVouchers } = require("../../scripts/reconcile-voucher-claims")
  const { encode: encodeInvoice, sign: signInvoice } = require("bolt11")
  /* eslint-enable @typescript-eslint/no-require-imports */

  const PRIVKEY = "e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734"
  const HASH = "ab".repeat(32)
  const MINUTE = 60_000
  // Both claimed 31 days ago, 5 minutes apart: B's payment falls inside A's
  // [-2 min, +30 min] window.
  const A_CLAIMED_AT = NOW - 31 * DAY_MS
  const B_CLAIMED_AT = A_CLAIMED_AT + 5 * MINUTE

  const redeemed = (
    id: string,
    status: string,
    claimedAt: number,
  ): [string, unknown[]] => [
    `INSERT INTO vouchers (id, amount_sats, wallet_id, status, expires_at, claimed, claimed_at, api_key_encrypted)
     VALUES ($1, 500, 'w1', $2, $3, true, $4, 'enc')`,
    [id, status, claimedAt + DAY_MS, claimedAt],
  ]

  const paymentOfB = () => {
    const encoded = encodeInvoice({
      satoshis: 500,
      timestamp: Math.floor(B_CLAIMED_AT / 1000),
      tags: [
        { tagName: "payment_hash", data: HASH },
        { tagName: "payment_secret", data: "11".repeat(32) },
        { tagName: "description", data: "voucher" },
      ],
    })
    return {
      id: "tx-b",
      direction: "SEND",
      status: "SUCCESS",
      settlementAmount: -500,
      settlementFee: 0,
      settlementCurrency: "BTC",
      createdAt: Math.floor(B_CLAIMED_AT / 1000),
      memo: "BlinkPOS Voucher: 500 sats",
      initiationVia: {
        __typename: "InitiationViaLn",
        paymentHash: HASH,
        paymentRequest: signInvoice(encoded, PRIVKEY).paymentRequest,
      },
    }
  }

  /** Rows as the script's SELECT would see them after `afterCleanup` ran. */
  const survivingRows = (afterCleanup: Array<[string, unknown[]]>) =>
    probe(
      [
        redeemed("a-stuck", "CLAIMED", A_CLAIMED_AT),
        redeemed("b-settled", "PAID", B_CLAIMED_AT),
        ...afterCleanup,
      ],
      `SELECT id, status, amount_sats, usd_amount_cents, wallet_id, api_key_encrypted,
              claimed_at, environment, wallet_currency, display_amount,
              display_currency, commission_percent
       FROM vouchers WHERE status IN ('CLAIMED', 'PAID') ORDER BY wallet_id, claimed_at`,
      [],
      { extraDdl: [CLEANUP_FUNCTION_SQL] },
    ).rows

  const reconcile = async (rows: Array<Record<string, unknown>>) => {
    const updates: unknown[][] = []
    const client = {
      query: jest.fn(async (text: string, params: unknown[]) => {
        if (text.startsWith("UPDATE")) {
          updates.push(params)
          return { rows: [{ id: params[0] }], rowCount: 1 }
        }
        return { rows: [] }
      }),
      release: jest.fn(),
    }
    const pool = {
      query: jest.fn(async () => ({ rows })),
      connect: jest.fn(async () => client),
    }
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: async () => ({ transactions: [paymentOfB()], complete: true }),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })
    return { summary, updates }
  }

  it("after cleanup, the scrubbed PAID competitor still blocks the stuck claim", async () => {
    const rows = survivingRows([["SELECT cleanup_old_vouchers()", []]])
    expect(rows.map((r) => [r.id, r.api_key_encrypted])).toEqual([
      ["a-stuck", "enc"],
      ["b-settled", ""], // kept, secret scrubbed
    ])

    const { summary, updates } = await reconcile(rows)
    expect(summary).toMatchObject({ checked: 1, matched: 0, ambiguous: 1, applied: 0 })
    expect(updates).toEqual([]) // A stays CLAIMED — still a liability
  })

  it("control: had cleanup deleted the PAID row, the unpaid claim would be settled", async () => {
    const rows = survivingRows([["DELETE FROM vouchers WHERE id = 'b-settled'", []]])
    expect(rows.map((r) => r.id)).toEqual(["a-stuck"])

    const { summary, updates } = await reconcile(rows)
    expect(summary).toMatchObject({ matched: 1, applied: 1 })
    expect(updates).toEqual([["a-stuck"]]) // the unsafe outcome the scrub prevents
  })
})

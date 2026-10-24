/** @jest-environment node */

/**
 * Owner voucher listing, paginated (blink-wip#1617), on real Postgres.
 *
 * Before: GET /api/voucher/list returned at most the newest 500 vouchers and
 * applied the status filter AFTER that cap, so older vouchers (and older
 * matches of a filter) could never be listed. Now: keyset pagination on
 * (created_at, id) with an opaque cursor, and the status filter in SQL.
 */

// Must stay first: sets the env lib/auth reads at module load.
import "./env"

import type { Client } from "pg"

import { getVoucherStatus, isRedeemedStatus } from "../../../lib/voucher-expiry"
import {
  decodeVoucherCursor,
  encodeVoucherCursor,
  OWNER_LIST_STATUSES,
  ownerListingSql,
  VoucherStore,
} from "../../../lib/voucher-store"
import listHandler from "../../../pages/api/voucher/list"

import { describePg, indexesUsed, setupTestDatabase, type TestDatabase } from "./harness"

jest.mock("../../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_READ: {},
}))
// The live Blink ownership lookup is the only thing not run for real.
jest.mock("../../../lib/wallet-ownership", () => ({
  ...jest.requireActual("../../../lib/wallet-ownership"),
  getOwnedWallets: jest.fn(async () => ({
    ok: true,
    wallets: new Map([["w1", { id: "w1", walletCurrency: "BTC" }]]),
  })),
}))

jest.setTimeout(90_000)

const HOUR = 3600_000

describePg("voucher list pagination on real Postgres", () => {
  let db: TestDatabase
  let sql: Client
  const store = () => {
    const s = new VoucherStore()
    s.lastCleanup = Date.now() // no lazy cleanup deleting test rows
    return s
  }

  beforeAll(async () => {
    db = await setupTestDatabase("voucher_pages")
    sql = await db.connect()
  })
  afterAll(async () => {
    await sql?.end()
    await db?.teardown()
  })
  beforeEach(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {})
    jest.spyOn(console, "error").mockImplementation(() => {})
    await sql.query("TRUNCATE vouchers")
  })

  const id = (n: number) => n.toString(16).padStart(32, "0")

  /** n vouchers for w1, created_at in groups of `tie` equal timestamps. */
  const seed = async (n: number, tie = 1, o: { status?: (i: number) => string } = {}) => {
    const now = Date.now()
    await sql.query(
      `INSERT INTO vouchers
         (id, amount_sats, wallet_id, api_key_encrypted, status, claimed, claimed_at,
          created_at, expires_at, expiry_id, cancelled_at, environment, wallet_currency)
       SELECT lpad(to_hex(i), 32, '0'), 500, 'w1', 'enc', 'ACTIVE', FALSE, NULL,
              $2::bigint - (i / $3) * 1000, $2::bigint + ${HOUR}, '24h', NULL, 'production', 'BTC'
       FROM generate_series(1, $1) AS i`,
      [n, now, tie],
    )
    if (o.status) {
      for (let i = 1; i <= n; i++) {
        const s = o.status(i)
        if (s === "EXPIRED")
          await sql.query("UPDATE vouchers SET expires_at = $2 WHERE id = $1", [
            id(i),
            now - HOUR,
          ])
      }
    }
  }

  const allIdsNewestFirst = async () =>
    // The listing's order: created_at, then SHA-256 of the id (never the id).
    (
      await sql.query(
        "SELECT id FROM vouchers ORDER BY created_at DESC, encode(sha256(convert_to(id, 'UTF8')), 'hex') DESC",
      )
    ).rows.map((r) => r.id as string)

  const call = async (query: Record<string, string>) => {
    const res = {
      statusCode: 0,
      body: undefined as unknown as {
        vouchers: { id: string; status: string }[]
        nextCursor: string | null
        truncated: boolean
        stats: { total: number }
        error?: string
      },
      setHeader: jest.fn(),
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(payload: never) {
        this.body = payload
        return this
      },
    }
    await listHandler(
      {
        method: "GET",
        query: { environment: "production", ...query },
        headers: { "x-voucher-api-key": "blink_test_key" },
        cookies: {},
      } as never,
      res as never,
    )
    return res
  }

  /** Follow nextCursor until the last page; returns every id in order. */
  const walk = async (query: Record<string, string>) => {
    const ids: string[] = []
    let before: string | null = null
    let pages = 0
    do {
      const res = await call({ ...query, ...(before ? { before } : {}) })
      expect(res.statusCode).toBe(200)
      ids.push(...res.body.vouchers.map((v) => v.id))
      expect(res.body.truncated).toBe(res.body.nextCursor !== null)
      before = res.body.nextCursor
      pages++
    } while (before && pages < 1000)
    return { ids, pages }
  }

  it("store: cursor pages cover every voucher once, in order, across equal created_at", async () => {
    await seed(23, 5) // groups of 5 vouchers share a created_at
    const seen: string[] = []
    let before = null as ReturnType<typeof decodeVoucherCursor>
    for (;;) {
      const page = await store().getVouchersByWalletIds(["w1"], "production", 4, {
        before,
      })
      seen.push(...page.map((v) => v.id))
      if (page.length < 4) break
      before = decodeVoucherCursor(encodeVoucherCursor(page[page.length - 1]))
    }
    expect(seen).toEqual(await allIdsNewestFirst())
    expect(new Set(seen).size).toBe(23)
  })

  it("route: walking nextCursor returns every voucher beyond the old 500 cap, once", async () => {
    await seed(520, 3)
    const { ids, pages } = await walk({ limit: "100" })
    expect(ids).toEqual(await allIdsNewestFirst())
    expect(pages).toBe(6)
    const first = await call({})
    expect(first.body.vouchers).toHaveLength(500) // no limit: 500, as before pagination
    expect(first.body.stats.total).toBe(520) // stats are never paged
  })

  it("no cursor (and so no request URL) ever contains a voucher id — ids are redemption secrets", async () => {
    await seed(60, 4)
    const all = await allIdsNewestFirst()
    let before: string | null = null
    const cursors: string[] = []
    do {
      const res = await call({ limit: "7", ...(before ? { before } : {}) })
      before = res.body.nextCursor
      if (before) cursors.push(before)
    } while (before)
    expect(cursors.length).toBeGreaterThan(5)
    for (const cursor of cursors) {
      const url = `/api/voucher/list?limit=7&before=${encodeURIComponent(cursor)}`
      for (const voucherId of all) {
        expect(url).not.toContain(voucherId)
        expect(url.toUpperCase()).not.toContain(voucherId.substring(0, 8).toUpperCase())
      }
    }
  })

  it("route: a status filter reaches old matches (was applied after the 500 cap)", async () => {
    // The 10 OLDEST vouchers are expired; 510 newer ones are active.
    await seed(520, 1, { status: (i) => (i > 510 ? "EXPIRED" : "ACTIVE") })
    const { ids } = await walk({ status: "expired", limit: "4" })
    expect(ids).toHaveLength(10)
    expect(ids).toEqual((await allIdsNewestFirst()).slice(510))
  })

  it("SQL status filters classify exactly like getVoucherStatus", async () => {
    const now = Date.now()
    const rows: [string, Record<string, unknown>][] = [
      ["active", {}],
      ["expired", { expires_at: now - HOUR }],
      ["cancelled", { cancelled_at: now - 1 }],
      ["cancelled+expired", { cancelled_at: now - 1, expires_at: now - HOUR }],
      ["claimed", { claimed: true, status: "CLAIMED", claimed_at: now }],
      ["claimed+expired", { claimed: true, status: "CLAIMED", expires_at: now - HOUR }],
      ["claimed+cancelled", { claimed: true, status: "CLAIMED", cancelled_at: now }],
      ["paid", { claimed: true, status: "PAID" }],
      ["paid+expired", { claimed: true, status: "PAID", expires_at: now - HOUR }],
    ]
    let n = 0
    for (const [, cols] of rows) {
      n++
      await sql.query(
        `INSERT INTO vouchers
           (id, amount_sats, wallet_id, api_key_encrypted, status, claimed, claimed_at,
            created_at, expires_at, expiry_id, cancelled_at, environment, wallet_currency)
         VALUES ($1, 500, 'w1', 'enc', $2, $3, $4, $5, $6, '24h', $7, 'production', 'BTC')`,
        [
          id(n),
          cols.status ?? "ACTIVE",
          cols.claimed ?? false,
          cols.claimed_at ?? null,
          now - n,
          cols.expires_at ?? now + HOUR,
          cols.cancelled_at ?? null,
        ],
      )
    }
    const all = await store().getVouchersByWalletIds(["w1"], "production")
    for (const status of OWNER_LIST_STATUSES) {
      const expected = all
        .filter((v) => {
          const derived = getVoucherStatus(v)
          return status === "CLAIMED" ? isRedeemedStatus(derived) : derived === status
        })
        .map((v) => v.id)
      const got = (
        await store().getVouchersByWalletIds(["w1"], "production", 500, { status })
      ).map((v) => v.id)
      expect({ status, ids: got }).toEqual({ status, ids: expected })
    }
    // Every row lands in exactly one of ACTIVE / CLAIMED / CANCELLED / EXPIRED.
    const buckets = await Promise.all(
      (["ACTIVE", "CLAIMED", "CANCELLED", "EXPIRED"] as const).map((status) =>
        store().getVouchersByWalletIds(["w1"], "production", 500, { status }),
      ),
    )
    expect(buckets.reduce((sum, b) => sum + b.length, 0)).toBe(rows.length)
  })

  it("route: rejects a malformed cursor, limit or status", async () => {
    const bad: Record<string, string>[] = [
      { before: "nope" },
      { before: "1_' OR 1=1 --" },
      { limit: "0" },
      { limit: "501" },
      { limit: "abc" },
      { status: "whatever" },
    ]
    for (const query of bad) {
      const res = await call(query)
      expect({ query, status: res.statusCode }).toEqual({ query, status: 400 })
    }
  })

  it("every listing shape (cursor, status) can use idx_vouchers_env_wallet_created", async () => {
    const base = [["w1", "w2"], "production", 101]
    for (const [shape, params] of [
      [{}, base],
      [{ cursor: true }, [...base, Date.now(), "0".repeat(64)]],
      [{ status: "EXPIRED" as const }, [...base, Date.now()]],
      [{ status: "CLAIMED" as const }, base],
      [
        { cursor: true, status: "ACTIVE" as const },
        [...base, Date.now(), "0".repeat(64), Date.now()],
      ],
    ] as const) {
      expect(await indexesUsed(sql, ownerListingSql(shape), [...params])).toContain(
        "idx_vouchers_env_wallet_created",
      )
    }
  })
})

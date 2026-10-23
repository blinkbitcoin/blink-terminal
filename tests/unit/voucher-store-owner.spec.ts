/** @jest-environment node */

/**
 * Owner-scoped voucher queries: SQL contract (wallet ids + environment,
 * capped, newest first, no key decryption) and the stats aggregate.
 * The repo has no Postgres test harness, so the pool is mocked.
 */

const mockPoolQuery = jest.fn()
const mockClientQuery = jest.fn()
const mockClientRelease = jest.fn()
jest.mock("../../lib/db", () => ({
  getSharedPool: () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: () =>
      Promise.resolve({ query: mockClientQuery, release: mockClientRelease }),
  }),
}))
const mockDecrypt = jest.fn(() => "decrypted")
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { decryptApiKey: () => mockDecrypt(), encryptApiKey: (k: string) => k },
}))

import { OWNER_LIST_LIMIT, VoucherStore } from "../../lib/voucher-store"

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "a".repeat(32),
  amount_sats: "500",
  claimed: false,
  claimed_at: null,
  created_at: String(Date.now()),
  expires_at: String(Date.now() + 3600_000),
  expiry_id: "24h",
  cancelled_at: null,
  api_key_encrypted: "enc",
  wallet_id: "w1",
  commission_percent: "0",
  display_amount: null,
  display_currency: null,
  status: "ACTIVE",
  environment: null,
  wallet_currency: "BTC",
  usd_amount_cents: null,
  ...overrides,
})

const store = () => {
  const s = new VoucherStore()
  s.lastCleanup = Date.now() // skip lazy cleanup queries
  return s
}

beforeEach(() => {
  mockPoolQuery.mockReset()
  mockClientQuery.mockReset()
  mockClientRelease.mockClear()
  mockDecrypt.mockClear()
})

describe("getVouchersByWalletIds", () => {
  it("filters by wallet ids and environment, newest first, capped", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [row()] })

    const vouchers = await store().getVouchersByWalletIds(["w1", "w2"], "production")

    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(sql).toMatch(/COALESCE\(environment, 'production'\) = \$2/)
    expect(sql).toMatch(/wallet_id = ANY\(\$1\)/)
    expect(sql).toMatch(/ORDER BY created_at DESC\s+LIMIT \$3/)
    expect(params).toEqual([["w1", "w2"], "production", OWNER_LIST_LIMIT])
    expect(vouchers).toHaveLength(1)
    expect(vouchers[0]).toMatchObject({ walletId: "w1", environment: "production" })
  })

  it("never decrypts stored API keys", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [row(), row({ id: "b".repeat(32) })] })
    const vouchers = await store().getVouchersByWalletIds(["w1"], "production")
    expect(mockDecrypt).not.toHaveBeenCalled()
    expect(vouchers.every((v) => v.apiKey === null)).toBe(true)
  })

  it("clamps the limit to the maximum", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await store().getVouchersByWalletIds(["w1"], "staging", 10_000)
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([["w1"], "staging", OWNER_LIST_LIMIT])
  })

  it("does not query for an empty wallet set", async () => {
    await expect(store().getVouchersByWalletIds([], "production")).resolves.toEqual([])
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it("recomputes a stale status", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [row({ expires_at: String(Date.now() - 1000), status: "ACTIVE" })],
    })
    const [voucher] = await store().getVouchersByWalletIds(["w1"], "production")
    expect(voucher.status).toBe("EXPIRED")
  })

  it("keeps a persisted PAID status; an unresolved claim stays CLAIMED", async () => {
    const claimedAt = String(Date.now() - 60_000)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        // Settled redemption: claimed stays true, status is terminal PAID
        row({ id: "p".repeat(32), status: "PAID", claimed: true, claimed_at: claimedAt }),
        // Payout still in flight / unresolved
        row({
          id: "c".repeat(32),
          status: "CLAIMED",
          claimed: true,
          claimed_at: claimedAt,
        }),
      ],
    })
    const vouchers = await store().getVouchersByWalletIds(["w1"], "production")
    expect(vouchers.map((v) => v.status)).toEqual(["PAID", "CLAIMED"])
  })
})

describe("getVoucherStatsByWalletIds", () => {
  it("aggregates over the full owner set with the same scoping", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          total: "9",
          active: "2",
          claimed: "3",
          cancelled: "1",
          expired: "3",
          expiring_soon: "1",
        },
      ],
    })

    const stats = await store().getVoucherStatsByWalletIds(["w1"], "production")

    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(sql).toMatch(/COALESCE\(environment, 'production'\) = \$2/)
    expect(sql).toMatch(/wallet_id = ANY\(\$1\)/)
    expect(sql).not.toMatch(/LIMIT/)
    expect(params.slice(0, 2)).toEqual([["w1"], "production"])
    expect(params[3] - params[2]).toBe(24 * 60 * 60 * 1000)
    expect(stats).toEqual({
      total: 9,
      active: 2,
      claimed: 3,
      cancelled: 1,
      expired: 3,
      expiringSoon: 1,
    })
  })

  it("returns zeros for an empty wallet set without querying", async () => {
    await expect(store().getVoucherStatsByWalletIds([], "production")).resolves.toEqual({
      total: 0,
      active: 0,
      claimed: 0,
      cancelled: 0,
      expired: 0,
      expiringSoon: 0,
    })
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})

/**
 * Backing-ceiling creation (blink-wip#1665): with maxLiabilityMinor set, the
 * insert runs in a per-wallet-locked transaction that counts existing ACTIVE,
 * unexpired liabilities — sequential or concurrent creates cannot aggregate
 * beyond the wallet balance.
 */
describe("createVoucher liability ceiling", () => {
  const create = (
    amount: number,
    options: Record<string, unknown> = {},
    existingTotal = "600",
  ) => {
    // Quota check goes through the pool; the transaction through the client.
    mockPoolQuery.mockResolvedValue({ rows: [{ count: "0" }] })
    mockClientQuery.mockImplementation(async (text: string) => {
      if (text.includes("SUM(")) return { rows: [{ total: existingTotal }] }
      if (text.startsWith("INSERT"))
        return { rows: [row({ amount_sats: String(amount) })] }
      return { rows: [] } // BEGIN / lock / COMMIT / ROLLBACK
    })
    return store().createVoucher(amount, "blink_key", "w1", options as never)
  }

  const queries = () => mockClientQuery.mock.calls.map((c) => c[0] as string)

  it("inserts within the ceiling, under a per-wallet advisory lock", async () => {
    const voucher = await create(400, { maxLiabilityMinor: 1000 }) // 600 + 400 = 1000

    expect(voucher.amount).toBe(400)
    const sql = queries()
    expect(sql[0]).toBe("BEGIN")
    expect(sql[1]).toContain("pg_advisory_xact_lock")
    expect(sql[2]).toContain("COALESCE(SUM(amount_sats)")
    expect(sql[3]).toContain("INSERT INTO vouchers")
    expect(sql[4]).toBe("COMMIT")
    // The lock is taken on the wallet id
    expect(mockClientQuery.mock.calls[1][1]).toEqual(["w1"])
    expect(mockClientRelease).toHaveBeenCalled()
  })

  it("refuses when existing liabilities + the new amount exceed the ceiling", async () => {
    await expect(create(401, { maxLiabilityMinor: 1000 })).rejects.toThrow(
      "exceeds the wallet balance",
    )
    const sql = queries()
    expect(sql.some((q) => q.startsWith("INSERT"))).toBe(false)
    expect(sql).toContain("ROLLBACK")
    expect(mockClientRelease).toHaveBeenCalled()
  })

  it("sums USD liabilities in cents", async () => {
    await create(2000, {
      maxLiabilityMinor: 1000,
      walletCurrency: "USD",
      usdAmount: 100,
      usdCentsPerSat: 0.05,
    })
    const sumQuery = queries()[2]
    // Existing USD vouchers are re-rated conservatively: only the smaller
    // display cents are persisted, so the aggregate must use
    // max(stored cents, ceil(sats * current rate)) (PR #94 review).
    expect(sumQuery).toContain("GREATEST")
    expect(sumQuery).toContain("CEIL(amount_sats * $3::numeric)")
    expect(mockClientQuery.mock.calls[2][1]).toEqual(["w1", expect.any(Number), 0.05])
  })

  it("fails closed when a USD ceiling check has no rate", async () => {
    await expect(
      create(2000, { maxLiabilityMinor: 1000, walletCurrency: "USD", usdAmount: 100 }),
    ).rejects.toThrow("USD liability check requires the current rate")
    expect(queries()).toContain("ROLLBACK")
    expect(queries().some((q) => q.startsWith("INSERT"))).toBe(false)
  })

  it("rounds a decimal-string SUM up (conservative direction)", async () => {
    // Postgres numeric SUM can return "100.5"; flooring would accept a
    // voucher the ceiling should reject: 101 + 900 > 1000 vs 100 + 900 = 1000.
    await expect(
      create(
        400,
        {
          maxLiabilityMinor: 1000,
          liabilityMinor: 900,
          walletCurrency: "USD",
          usdAmount: 100,
          usdCentsPerSat: 0.05,
        },
        "100.5",
      ),
    ).rejects.toThrow("exceeds the wallet balance")
  })

  it("liabilityMinor overrides the stored amount in the check", async () => {
    // Conservative USD backing: the sats' cent cost can exceed stored cents.
    await expect(
      create(400, { maxLiabilityMinor: 1000, liabilityMinor: 401 }), // 600 + 401 > 1000
    ).rejects.toThrow("exceeds the wallet balance")
  })

  it("counts in-flight CLAIMED vouchers in both aggregates", async () => {
    // claimVoucher marks CLAIMED before the payment round trip; a create
    // during that window must still see the liability (blink-wip#1665).
    // Expiry applies only to ACTIVE: a CLAIMED voucher past expires_at may
    // still settle and debit the wallet.
    await create(400, { maxLiabilityMinor: 1000 })
    expect(queries()[2]).toContain(
      "(status = 'CLAIMED' OR (status = 'ACTIVE' AND expires_at > $2))",
    )

    mockClientQuery.mockClear()
    await create(2000, {
      maxLiabilityMinor: 1000,
      walletCurrency: "USD",
      usdAmount: 100,
      usdCentsPerSat: 0.05,
    })
    expect(queries()[2]).toContain(
      "(status = 'CLAIMED' OR (status = 'ACTIVE' AND expires_at > $2))",
    )
  })

  it("claim-then-create: a full-balance in-flight redemption blocks a second full-balance voucher", async () => {
    // The reviewer's reproduction: 1,000-sat voucher claimed (payment in
    // flight), balance still reads 1,000 — the second 1,000-sat voucher must
    // be refused. (The mock's existingTotal is what the real SUM returns for
    // the CLAIMED row; the PGlite spec proves the SQL produces it.)
    await expect(create(1000, { maxLiabilityMinor: 1000 }, "1000")).rejects.toThrow(
      "exceeds the wallet balance",
    )
    expect(queries().some((q) => q.startsWith("INSERT"))).toBe(false)
  })

  it("uses the stored amount/cents as the default liability", async () => {
    // existing 600 + default liability 400 (amount) = 1000, within ceiling
    await expect(create(400, { maxLiabilityMinor: 1000 })).resolves.toBeTruthy()
  })

  it("without a ceiling, no transaction client is acquired", async () => {
    mockPoolQuery.mockImplementation(async (text: string) =>
      text.startsWith("INSERT")
        ? { rows: [row({ amount_sats: "400" })] }
        : { rows: [{ count: "0" }] },
    )
    const voucher = await store().createVoucher(400, "blink_key", "w1")
    expect(voucher.amount).toBe(400)
    expect(mockClientQuery).not.toHaveBeenCalled()
  })
})

describe("markVoucherPaid", () => {
  it("transitions only CLAIMED -> PAID", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: "v1" }], rowCount: 1 })
    await expect(store().markVoucherPaid("v1")).resolves.toBe(true)
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("SET status = 'PAID'")
    expect(sql).toContain("status = 'CLAIMED'")
    expect(params).toEqual(["v1"])
  })

  it("returns false when the voucher is not CLAIMED", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    await expect(store().markVoucherPaid("v1")).resolves.toBe(false)
  })
})

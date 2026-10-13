/** @jest-environment node */

/**
 * Owner-scoped voucher queries: SQL contract (wallet ids + environment,
 * capped, newest first, no key decryption) and the stats aggregate.
 * The repo has no Postgres test harness, so the pool is mocked.
 */

const mockPoolQuery = jest.fn()
jest.mock("../../lib/db", () => ({
  getSharedPool: () => ({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
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

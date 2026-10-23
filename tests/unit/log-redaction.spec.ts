/** @jest-environment node */

/**
 * blink-wip#1590: bearer secrets must not reach logs.
 *
 * A voucher id is the LNURL-withdraw k1 that redeems it. Every store path
 * that logs a voucher must log a short prefix, never the full id.
 */

const mockPoolQuery = jest.fn()
const mockClientQuery = jest.fn()
jest.mock("../../lib/db", () => ({
  getSharedPool: () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: () => Promise.resolve({ query: mockClientQuery, release: () => undefined }),
  }),
}))
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { encryptApiKey: (k: string) => k, decryptApiKey: (k: string) => k },
}))

import { shortId } from "../../lib/log-redact"
import { VoucherStore } from "../../lib/voucher-store"

const SECRET = "f00dfacecafebeef0123456789abcdef" // a voucher id = LNURL-withdraw k1

let logged: string[]
beforeEach(() => {
  logged = []
  const capture = (...args: unknown[]) => {
    logged.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    )
  }
  jest.spyOn(console, "log").mockImplementation(capture)
  jest.spyOn(console, "warn").mockImplementation(capture)
  jest.spyOn(console, "error").mockImplementation(capture)
  mockPoolQuery.mockReset()
  mockClientQuery.mockReset()
})

const store = () => {
  const s = new VoucherStore()
  s.lastCleanup = Date.now()
  return s
}

describe("shortId", () => {
  it("keeps 8 characters of a long id", () => {
    expect(shortId(SECRET)).toBe("f00dface…")
    expect(shortId("abc")).toBe("ab…")
    expect(shortId("")).toBe("missing")
    expect(shortId(undefined)).toBe("missing")
  })
})

describe("voucher store never logs a full voucher id", () => {
  const expectNoSecret = () => {
    expect(logged.length).toBeGreaterThan(0) // the paths did log something
    for (const line of logged) expect(line).not.toContain(SECRET)
    expect(logged.some((l) => l.includes(shortId(SECRET)))).toBe(true)
  }

  it("claim / cancel / unclaim, success and failure", async () => {
    mockPoolQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: SECRET }] })
    await store().claimVoucher(SECRET)
    await store().cancelVoucher(SECRET)
    await store().unclaimVoucher(SECRET)
    mockPoolQuery.mockResolvedValue({ rowCount: 0, rows: [] })
    await store().claimVoucher(SECRET)
    await store().cancelVoucher(SECRET)
    await store().unclaimVoucher(SECRET)
    await store().getVoucher(SECRET)
    expectNoSecret()
  })

  it("markVoucherPaid: paid, not found, not CLAIMED", async () => {
    const run = async (update: { rowCount: number }, found = true) => {
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql.startsWith("SELECT wallet_id"))
          return { rows: found ? [{ wallet_id: "w1" }] : [] }
        if (sql.startsWith("UPDATE")) return { ...update, rows: [] }
        return { rows: [] }
      })
      await store().markVoucherPaid(SECRET)
    }
    await run({ rowCount: 1 })
    await run({ rowCount: 0 })
    await run({ rowCount: 0 }, false)
    expectNoSecret()
  })

  it("create", async () => {
    jest.spyOn(VoucherStore.prototype, "generateChargeId").mockReturnValue(SECRET)
    mockPoolQuery.mockImplementation(async (sql: string) =>
      sql.startsWith("INSERT")
        ? {
            rows: [
              {
                id: SECRET,
                amount_sats: "500",
                claimed: false,
                created_at: String(Date.now()),
                expires_at: String(Date.now() + 60_000),
                expiry_id: "24h",
                wallet_id: "w1",
                commission_percent: "0",
                status: "ACTIVE",
                wallet_currency: "BTC",
              },
            ],
          }
        : { rows: [{ count: "0" }] },
    )
    await store().createVoucher(500, "blink_key", "w1")
    expectNoSecret()
  })
})

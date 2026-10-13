/** @jest-environment node */

/**
 * Voucher redemption + management authorization:
 * - the LNURL-withdraw callback only pays an invoice for exactly the voucher's
 *   face value, checked before the voucher is claimed;
 * - the voucher is released for retry only when the payment was definitely
 *   not sent;
 * - list / cancel are scoped to the voucher wallet API key that created the
 *   voucher; create requires that key to own the wallet.
 */

import { encode as encodeInvoice, sign as signInvoice } from "bolt11"

const mockStore = {
  getVoucher: jest.fn(),
  getVoucherWithStatus: jest.fn(),
  getAllVouchers: jest.fn(),
  claimVoucher: jest.fn(),
  unclaimVoucher: jest.fn(),
  cancelVoucher: jest.fn(),
  createVoucher: jest.fn(),
}
jest.mock("../../lib/voucher-store", () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) =>
          (mockStore as Record<string, (...a: unknown[]) => unknown>)[prop](...args),
    },
  ),
}))
jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_READ: {},
  RATE_LIMIT_WRITE: {},
}))

const mockPayLnInvoice = jest.fn()
const mockGetWalletInfo = jest.fn()
jest.mock("../../lib/blink-api", () => {
  class PaymentRejectedError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.code = code
    }
  }
  const BlinkAPI = jest.fn().mockImplementation(() => ({
    payLnInvoice: (...args: unknown[]) => mockPayLnInvoice(...args),
    getWalletInfo: (...args: unknown[]) => mockGetWalletInfo(...args),
  }))
  return { __esModule: true, default: BlinkAPI, BlinkAPI, PaymentRejectedError }
})

import { PaymentRejectedError } from "../../lib/blink-api"
import { clearOwnershipCache, VOUCHER_API_KEY_HEADER } from "../../lib/voucher-auth"
import callbackHandler from "../../pages/api/voucher/callback"
import cancelHandler from "../../pages/api/voucher/cancel"
import createHandler from "../../pages/api/voucher/create"
import listHandler from "../../pages/api/voucher/list"

type Handler = (req: never, res: never) => unknown

const PRIVKEY = "e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734"
const OWNER_KEY = "blink_owner_key"
const OTHER_KEY = "blink_other_key"

const invoice = ({
  sats,
  expireSeconds = 3600,
  ageSeconds = 0,
}: {
  sats?: number
  expireSeconds?: number
  ageSeconds?: number
}): string => {
  const encoded = encodeInvoice({
    ...(sats !== undefined ? { satoshis: sats } : {}),
    timestamp: Math.floor(Date.now() / 1000) - ageSeconds,
    tags: [
      { tagName: "payment_hash", data: "00".repeat(32) },
      { tagName: "payment_secret", data: "11".repeat(32) },
      { tagName: "description", data: "voucher test" },
      { tagName: "expire_time", data: expireSeconds },
    ],
  })
  return signInvoice(encoded, PRIVKEY).paymentRequest as string
}

const voucher = (overrides: Record<string, unknown> = {}) => ({
  id: "a".repeat(32),
  amount: 500,
  claimed: false,
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600_000,
  status: "ACTIVE",
  apiKey: OWNER_KEY,
  walletId: "wallet-1",
  environment: "production",
  walletCurrency: "BTC",
  ...overrides,
})

const call = async (handler: Handler, req: Record<string, unknown>) => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    send(payload: string) {
      this.body = JSON.parse(payload)
      return this
    },
    end() {
      return this
    },
  }
  await handler(
    { headers: {}, query: {}, body: {}, cookies: {}, ...req } as never,
    res as never,
  )
  return res
}

const redeem = (pr: string) =>
  call(callbackHandler as Handler, { method: "GET", query: { k1: "a".repeat(32), pr } })

beforeEach(() => {
  jest.clearAllMocks()
  clearOwnershipCache()
  jest.spyOn(console, "log").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
  mockStore.getVoucher.mockResolvedValue(voucher())
  mockStore.claimVoucher.mockResolvedValue(true)
  mockStore.unclaimVoucher.mockResolvedValue(true)
})

describe("voucher callback: invoice must match face value", () => {
  it.each([
    ["a larger amount", invoice({ sats: 1_000_000 }), "does not match"],
    ["a smaller amount", invoice({ sats: 499 }), "does not match"],
    ["no amount", invoice({}), "must specify an amount"],
    [
      "an expired invoice",
      invoice({ sats: 500, expireSeconds: 60, ageSeconds: 120 }),
      "expired",
    ],
    ["garbage", "lnbc1notaninvoice", "Invalid Lightning invoice"],
  ])("rejects %s without claiming or paying", async (_name, pr, reason) => {
    const res = await redeem(pr)

    expect(res.body).toEqual({ status: "ERROR", reason: expect.stringContaining(reason) })
    expect(mockStore.claimVoucher).not.toHaveBeenCalled()
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })

  it("pays an invoice for exactly the face value", async () => {
    mockPayLnInvoice.mockResolvedValueOnce({ status: "SUCCESS" })
    const pr = invoice({ sats: 500 })

    const res = await redeem(pr)

    expect(res.body).toEqual({ status: "OK" })
    expect(mockStore.claimVoucher).toHaveBeenCalledTimes(1)
    expect(mockPayLnInvoice).toHaveBeenCalledWith("wallet-1", pr, expect.any(String))
  })

  it("checks USD vouchers against the sats amount fixed at issuance", async () => {
    mockStore.getVoucher.mockResolvedValue(
      voucher({ walletCurrency: "USD", usdAmountCents: 100, amount: 1200 }),
    )
    expect((await redeem(invoice({ sats: 500 }))).body).toMatchObject({ status: "ERROR" })
    expect(mockPayLnInvoice).not.toHaveBeenCalled()

    mockPayLnInvoice.mockResolvedValueOnce({ status: "SUCCESS" })
    expect((await redeem(invoice({ sats: 1200 }))).body).toEqual({ status: "OK" })
  })

  it("rejects array-valued query parameters", async () => {
    const res = await call(callbackHandler as Handler, {
      method: "GET",
      query: { k1: ["a", "b"], pr: invoice({ sats: 500 }) },
    })
    expect(res.body).toMatchObject({ status: "ERROR" })
    expect(mockStore.getVoucher).not.toHaveBeenCalled()
  })
})

describe("voucher callback: release only when nothing was sent", () => {
  it("unclaims when the API rejects the payment", async () => {
    mockPayLnInvoice.mockRejectedValueOnce(
      new PaymentRejectedError("Insufficient balance", "INSUFFICIENT_BALANCE"),
    )
    const res = await redeem(invoice({ sats: 500 }))

    expect(res.body).toMatchObject({ status: "ERROR" })
    expect(mockStore.unclaimVoucher).toHaveBeenCalledTimes(1)
  })

  it("unclaims on a FAILURE status", async () => {
    mockPayLnInvoice.mockResolvedValueOnce({ status: "FAILURE" })
    await redeem(invoice({ sats: 500 }))
    expect(mockStore.unclaimVoucher).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      "a transport error",
      () => mockPayLnInvoice.mockRejectedValueOnce(new Error("socket hang up")),
    ],
    [
      "an unknown status",
      () => mockPayLnInvoice.mockResolvedValueOnce({ status: "WEIRD" }),
    ],
  ])("keeps the voucher claimed on %s", async (_name, arrange) => {
    arrange()
    const res = await redeem(invoice({ sats: 500 }))

    expect(res.body).toMatchObject({ status: "ERROR" })
    expect(mockStore.unclaimVoucher).not.toHaveBeenCalled()
  })

  it("keeps the voucher claimed and returns OK while PENDING", async () => {
    mockPayLnInvoice.mockResolvedValueOnce({ status: "PENDING" })
    expect((await redeem(invoice({ sats: 500 }))).body).toEqual({ status: "OK" })
    expect(mockStore.unclaimVoucher).not.toHaveBeenCalled()
  })
})

describe("voucher list is scoped to the caller's API key", () => {
  beforeEach(() => {
    mockStore.getAllVouchers.mockResolvedValue([
      voucher({ id: "1".repeat(32) }),
      voucher({ id: "2".repeat(32), apiKey: OTHER_KEY }),
      voucher({ id: "3".repeat(32), apiKey: null }),
    ])
  })

  it("requires the API key header", async () => {
    const res = await call(listHandler as Handler, { method: "GET" })
    expect(res.statusCode).toBe(401)
    expect(mockStore.getAllVouchers).not.toHaveBeenCalled()
  })

  it("ignores a key passed in the query string", async () => {
    const res = await call(listHandler as Handler, {
      method: "GET",
      query: { apiKey: OWNER_KEY },
    })
    expect(res.statusCode).toBe(401)
  })

  it("returns only the caller's vouchers and stats", async () => {
    const res = await call(listHandler as Handler, {
      method: "GET",
      headers: { [VOUCHER_API_KEY_HEADER]: OWNER_KEY },
    })

    const body = res.body as { vouchers: Array<{ id: string }>; stats: { total: number } }
    expect(res.statusCode).toBe(200)
    expect(body.vouchers.map((v) => v.id)).toEqual(["1".repeat(32)])
    expect(body.stats.total).toBe(1)
    expect(JSON.stringify(body)).not.toContain(OWNER_KEY)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("returns nothing for an unknown key", async () => {
    const res = await call(listHandler as Handler, {
      method: "GET",
      headers: { [VOUCHER_API_KEY_HEADER]: "blink_stranger" },
    })
    expect((res.body as { vouchers: unknown[] }).vouchers).toEqual([])
  })
})

describe("voucher cancel requires ownership", () => {
  const cancel = (headers: Record<string, string>) =>
    call(cancelHandler as Handler, {
      method: "POST",
      headers,
      body: { chargeId: "a".repeat(32) },
    })

  it("requires the API key header", async () => {
    expect((await cancel({})).statusCode).toBe(401)
    expect(mockStore.cancelVoucher).not.toHaveBeenCalled()
  })

  it("answers 404 for someone else's voucher and does not cancel it", async () => {
    mockStore.getVoucherWithStatus.mockResolvedValueOnce(voucher())
    const res = await cancel({ [VOUCHER_API_KEY_HEADER]: OTHER_KEY })
    expect(res.statusCode).toBe(404)
    expect(mockStore.cancelVoucher).not.toHaveBeenCalled()
  })

  it("cancels the owner's voucher", async () => {
    mockStore.getVoucherWithStatus.mockResolvedValueOnce(voucher())
    mockStore.cancelVoucher.mockResolvedValueOnce(true)
    const res = await cancel({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })
    expect(res.statusCode).toBe(200)
    expect(mockStore.cancelVoucher).toHaveBeenCalledWith("a".repeat(32))
  })
})

describe("voucher create requires the API key to own the wallet", () => {
  const create = () =>
    call(createHandler as Handler, {
      method: "POST",
      body: { amount: 500, apiKey: OWNER_KEY, walletId: "wallet-1" },
    })

  it("rejects a key that does not own the wallet", async () => {
    mockGetWalletInfo.mockResolvedValueOnce([{ id: "someone-elses-wallet" }])
    const res = await create()
    expect(res.statusCode).toBe(403)
    expect(mockStore.createVoucher).not.toHaveBeenCalled()
  })

  it("fails closed when the Blink API errors", async () => {
    mockGetWalletInfo.mockRejectedValueOnce(new Error("Invalid API key"))
    expect((await create()).statusCode).toBe(403)
    expect(mockStore.createVoucher).not.toHaveBeenCalled()
  })

  it("creates when the key owns the wallet, and caches the check for batches", async () => {
    mockGetWalletInfo.mockResolvedValue([{ id: "wallet-1", walletCurrency: "BTC" }])
    mockStore.createVoucher.mockResolvedValue({
      ...voucher(),
      expiryId: "24h",
      commissionPercent: 0,
    })

    expect((await create()).statusCode).toBe(200)
    expect((await create()).statusCode).toBe(200)
    expect(mockStore.createVoucher).toHaveBeenCalledTimes(2)
    expect(mockGetWalletInfo).toHaveBeenCalledTimes(1)
  })
})

/** @jest-environment node */

/**
 * Voucher redemption + management authorization:
 * - the LNURL-withdraw callback only pays an invoice for exactly the voucher's
 *   face value, checked before the voucher is claimed;
 * - the voucher is released for retry only when the payment was definitely
 *   not sent;
 * - list / cancel / create authorize by CURRENT wallet ownership, checked live
 *   against Blink (no cache): a revoked key stops working at once, a
 *   replacement key for the same wallet keeps working;
 * - create stores the wallet currency confirmed by Blink.
 */

import { encode as encodeInvoice, sign as signInvoice } from "bolt11"

const mockStore = {
  getVoucher: jest.fn(),
  getVoucherWithStatus: jest.fn(),
  getAllVouchers: jest.fn(),
  getVouchersByWalletIds: jest.fn(),
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
  const BlinkAPI = jest.fn().mockImplementation((apiKey: string, apiUrl: string) => ({
    payLnInvoice: (...args: unknown[]) => mockPayLnInvoice(...args),
    getWalletInfo: () => mockGetWalletInfo(apiKey, apiUrl),
  }))
  return { __esModule: true, default: BlinkAPI, BlinkAPI, PaymentRejectedError }
})

import { PaymentRejectedError } from "../../lib/blink-api"
import { VOUCHER_API_KEY_HEADER } from "../../lib/voucher-auth"
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

// Blink's view of each key: walletId -> currency per environment. Missing
// key => Blink rejects it (revoked / invalid).
const PROD = "https://api.blink.sv/graphql"
const STAGING = "https://api.staging.blink.sv/graphql"
let blinkAccounts: Record<
  string,
  Record<string, Array<{ id: string; walletCurrency: string }>>
>

const setBlinkAccounts = (accounts: typeof blinkAccounts) => {
  blinkAccounts = accounts
  mockGetWalletInfo.mockImplementation(async (apiKey: string, apiUrl: string) => {
    const wallets = blinkAccounts[apiKey]?.[apiUrl]
    if (!wallets) throw new Error("Invalid API key")
    return wallets
  })
}

const BTC_WALLET = { id: "wallet-1", walletCurrency: "BTC" }
const USD_WALLET = { id: "wallet-usd", walletCurrency: "USD" }

beforeEach(() => {
  setBlinkAccounts({
    [OWNER_KEY]: {
      [PROD]: [BTC_WALLET, USD_WALLET],
      [STAGING]: [{ id: "wallet-stg", walletCurrency: "BTC" }],
    },
    // A rotated replacement key for the same account
    blink_new_owner_key: { [PROD]: [BTC_WALLET, USD_WALLET] },
    [OTHER_KEY]: { [PROD]: [{ id: "wallet-9", walletCurrency: "BTC" }] },
  })
})

describe("voucher list: current wallet owner only", () => {
  const list = (headers: Record<string, string>, query: Record<string, unknown> = {}) =>
    call(listHandler as Handler, { method: "GET", headers, query })

  beforeEach(() => {
    mockStore.getVouchersByWalletIds.mockResolvedValue([voucher({ id: "1".repeat(32) })])
  })

  it("requires the API key header", async () => {
    expect((await list({})).statusCode).toBe(401)
    expect(mockGetWalletInfo).not.toHaveBeenCalled()
    expect(mockStore.getVouchersByWalletIds).not.toHaveBeenCalled()
  })

  it("ignores a key passed in the query string", async () => {
    expect((await list({}, { apiKey: OWNER_KEY })).statusCode).toBe(401)
  })

  it("rejects a revoked / invalid key", async () => {
    const res = await list({ [VOUCHER_API_KEY_HEADER]: "blink_revoked_key" })
    expect(res.statusCode).toBe(401)
    expect(mockStore.getVouchersByWalletIds).not.toHaveBeenCalled()
  })

  it("queries only the wallets the key currently owns, per environment", async () => {
    const res = await list({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })

    expect(res.statusCode).toBe(200)
    expect(mockStore.getVouchersByWalletIds).toHaveBeenCalledWith(
      ["wallet-1", "wallet-usd"],
      "production",
    )
    const body = res.body as { vouchers: Array<{ id: string }>; stats: { total: number } }
    expect(body.vouchers.map((v) => v.id)).toEqual(["1".repeat(32)])
    expect(body.stats.total).toBe(1)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("scopes to the requested environment (staging)", async () => {
    await list({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY }, { environment: "staging" })
    expect(mockGetWalletInfo).toHaveBeenCalledWith(OWNER_KEY, STAGING)
    expect(mockStore.getVouchersByWalletIds).toHaveBeenCalledWith(
      ["wallet-stg"],
      "staging",
    )
  })

  it("a replacement key for the same wallets sees the same vouchers", async () => {
    await list({ [VOUCHER_API_KEY_HEADER]: "blink_new_owner_key" })
    expect(mockStore.getVouchersByWalletIds).toHaveBeenCalledWith(
      ["wallet-1", "wallet-usd"],
      "production",
    )
  })

  it("re-checks with Blink on every request (no cache)", async () => {
    await list({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })
    delete blinkAccounts[OWNER_KEY] // key revoked
    expect((await list({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })).statusCode).toBe(401)
    expect(mockGetWalletInfo).toHaveBeenCalledTimes(2)
  })
})

describe("voucher cancel: current wallet owner only", () => {
  const cancel = (headers: Record<string, string>) =>
    call(cancelHandler as Handler, {
      method: "POST",
      headers,
      body: { chargeId: "a".repeat(32) },
    })

  beforeEach(() => {
    mockStore.getVoucherWithStatus.mockResolvedValue(voucher())
    mockStore.cancelVoucher.mockResolvedValue(true)
  })

  it("requires the API key header", async () => {
    expect((await cancel({})).statusCode).toBe(401)
    expect(mockStore.cancelVoucher).not.toHaveBeenCalled()
  })

  it.each([
    ["a key for another account", OTHER_KEY],
    ["the creating key after revocation", "blink_revoked_key"],
  ])("answers 404 for %s and does not cancel", async (_name, key) => {
    const res = await cancel({ [VOUCHER_API_KEY_HEADER]: key })
    expect(res.statusCode).toBe(404)
    expect(mockStore.cancelVoucher).not.toHaveBeenCalled()
  })

  it.each([
    ["the creating key", OWNER_KEY],
    ["a replacement key for the same wallet", "blink_new_owner_key"],
  ])("cancels with %s", async (_name, key) => {
    const res = await cancel({ [VOUCHER_API_KEY_HEADER]: key })
    expect(res.statusCode).toBe(200)
    expect(mockStore.cancelVoucher).toHaveBeenCalledWith("a".repeat(32))
  })

  it("checks ownership in the voucher's own environment", async () => {
    mockStore.getVoucherWithStatus.mockResolvedValueOnce(
      voucher({ walletId: "wallet-stg", environment: "staging" }),
    )
    const res = await cancel({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })
    expect(mockGetWalletInfo).toHaveBeenCalledWith(OWNER_KEY, STAGING)
    expect(res.statusCode).toBe(200)
  })
})

describe("voucher create: live ownership + confirmed wallet currency", () => {
  const create = (body: Record<string, unknown> = {}) =>
    call(createHandler as Handler, {
      method: "POST",
      body: { amount: 500, apiKey: OWNER_KEY, walletId: "wallet-1", ...body },
    })

  beforeEach(() => {
    mockStore.createVoucher.mockImplementation(async (amount, _key, walletId, opts) => ({
      ...voucher({ amount, walletId }),
      walletCurrency: opts.walletCurrency,
      usdAmountCents: opts.usdAmount ?? null,
      expiryId: "24h",
      commissionPercent: 0,
    }))
  })

  it("rejects a key that does not own the wallet", async () => {
    const res = await create({ apiKey: OTHER_KEY })
    expect(res.statusCode).toBe(403)
    expect(mockStore.createVoucher).not.toHaveBeenCalled()
  })

  it("fails closed when Blink rejects the key", async () => {
    expect((await create({ apiKey: "blink_revoked_key" })).statusCode).toBe(403)
    expect(mockStore.createVoucher).not.toHaveBeenCalled()
  })

  it("re-checks with Blink on every create (no revocation window)", async () => {
    expect((await create()).statusCode).toBe(200)
    expect((await create()).statusCode).toBe(200)
    expect(mockGetWalletInfo).toHaveBeenCalledTimes(2)

    delete blinkAccounts[OWNER_KEY] // key revoked mid-batch
    expect((await create()).statusCode).toBe(403)
    expect(mockStore.createVoucher).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["BTC requested for a USD wallet", { walletId: "wallet-usd", walletCurrency: "BTC" }],
    [
      "USD requested for a BTC wallet",
      { walletId: "wallet-1", walletCurrency: "USD", usdAmount: 100 },
    ],
  ])("rejects %s", async (_name, body) => {
    const res = await create(body)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: "walletCurrency does not match the wallet" })
    expect(mockStore.createVoucher).not.toHaveBeenCalled()
  })

  it("stores a matching USD voucher with its cents amount", async () => {
    const res = await create({
      walletId: "wallet-usd",
      walletCurrency: "USD",
      usdAmount: 100,
    })
    expect(res.statusCode).toBe(200)
    expect(mockStore.createVoucher).toHaveBeenCalledWith(
      500,
      OWNER_KEY,
      "wallet-usd",
      expect.objectContaining({ walletCurrency: "USD", usdAmount: 100 }),
    )
  })

  it("ignores a stray usdAmount on a BTC voucher", async () => {
    await create({ walletCurrency: "BTC", usdAmount: 100 })
    expect(mockStore.createVoucher).toHaveBeenCalledWith(
      500,
      OWNER_KEY,
      "wallet-1",
      expect.objectContaining({ walletCurrency: "BTC", usdAmount: undefined }),
    )
  })

  it("normalizes an unknown environment to production", async () => {
    await create({ environment: "http://evil.example" })
    expect(mockGetWalletInfo).toHaveBeenCalledWith(OWNER_KEY, PROD)
  })
})

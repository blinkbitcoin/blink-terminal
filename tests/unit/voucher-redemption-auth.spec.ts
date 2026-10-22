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
  getVoucherStatsByWalletIds: jest.fn(),
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
const mockGetExchangeRate = jest.fn()
jest.mock("../../lib/blink-api", () => {
  class PaymentRejectedError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.code = code
    }
  }
  class BlinkAuthError extends Error {}
  const BlinkAPI = jest.fn().mockImplementation((apiKey: string, apiUrl: string) => ({
    payLnInvoice: (...args: unknown[]) => mockPayLnInvoice(...args),
    getWalletInfo: () => mockGetWalletInfo(apiKey, apiUrl),
    getExchangeRate: (currency: string) => mockGetExchangeRate(apiKey, apiUrl, currency),
  }))
  return {
    __esModule: true,
    default: BlinkAPI,
    BlinkAPI,
    BlinkAuthError,
    PaymentRejectedError,
  }
})

import { BlinkAuthError, PaymentRejectedError } from "../../lib/blink-api"
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
  // Server-side rate for USD pair cross-checks: 0.05 cents/sat, so
  // 100 cents = 2000 sats.
  mockGetExchangeRate.mockResolvedValue({ satPriceInCurrency: 0.05, currency: "USD" })
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

  it("unclaims with a clear reason when the voucher's funding key was revoked", async () => {
    mockPayLnInvoice.mockRejectedValueOnce(
      new BlinkAuthError("Blink API rejected the API key (401)"),
    )
    const res = await redeem(invoice({ sats: 500 }))

    expect(res.body).toEqual({
      status: "ERROR",
      reason: "This voucher's wallet is no longer available - contact the issuer",
    })
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
let blinkDown = false
let blinkAccounts: Record<
  string,
  Record<string, Array<{ id: string; walletCurrency: string; balance: number }>>
>

const setBlinkAccounts = (accounts: typeof blinkAccounts) => {
  blinkAccounts = accounts
  mockGetWalletInfo.mockImplementation(async (apiKey: string, apiUrl: string) => {
    if (blinkDown) throw new Error("Blink API returned non-JSON response (502)")
    const wallets = blinkAccounts[apiKey]?.[apiUrl]
    if (!wallets) throw new BlinkAuthError("Blink API rejected the API key (401)")
    return wallets
  })
}

// Balances are minor units: sats for BTC wallets, cents for USD wallets.
const BTC_WALLET = { id: "wallet-1", walletCurrency: "BTC", balance: 1000 }
const USD_WALLET = { id: "wallet-usd", walletCurrency: "USD", balance: 500 }

beforeEach(() => {
  blinkDown = false
  setBlinkAccounts({
    [OWNER_KEY]: {
      [PROD]: [BTC_WALLET, USD_WALLET],
      [STAGING]: [{ id: "wallet-stg", walletCurrency: "BTC", balance: 1000 }],
    },
    // A rotated replacement key for the same account
    blink_new_owner_key: { [PROD]: [BTC_WALLET, USD_WALLET] },
    [OTHER_KEY]: { [PROD]: [{ id: "wallet-9", walletCurrency: "BTC", balance: 1000 }] },
  })
})

describe("voucher list: current wallet owner only", () => {
  const list = (headers: Record<string, string>, query: Record<string, unknown> = {}) =>
    call(listHandler as Handler, { method: "GET", headers, query })

  beforeEach(() => {
    mockStore.getVouchersByWalletIds.mockResolvedValue([voucher({ id: "1".repeat(32) })])
    mockStore.getVoucherStatsByWalletIds.mockResolvedValue({
      total: 7,
      active: 1,
      claimed: 3,
      cancelled: 1,
      expired: 2,
      expiringSoon: 0,
    })
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
    // Stats come from the uncapped store aggregate, not the listed page
    expect(body.stats.total).toBe(7)
    expect(mockStore.getVoucherStatsByWalletIds).toHaveBeenCalledWith(
      ["wallet-1", "wallet-usd"],
      "production",
    )
    expect((res.body as { truncated: boolean }).truncated).toBe(false)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("answers 503 (not 401) when Blink is unavailable", async () => {
    blinkDown = true
    const res = await list({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })
    expect(res.statusCode).toBe(503)
    expect(mockStore.getVouchersByWalletIds).not.toHaveBeenCalled()
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

  it("answers 503 when Blink is unavailable and does not cancel", async () => {
    blinkDown = true
    const res = await cancel({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })
    expect(res.statusCode).toBe(503)
    expect(mockStore.cancelVoucher).not.toHaveBeenCalled()
  })

  it("answers 409 when a redemption wins the race against the cancel", async () => {
    mockStore.getVoucherWithStatus
      .mockResolvedValueOnce(voucher())
      .mockResolvedValueOnce(voucher({ claimed: true, status: "CLAIMED" }))
    mockStore.cancelVoucher.mockResolvedValueOnce(false)

    const res = await cancel({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({
      error: "Voucher is no longer active (claimed)",
      status: "CLAIMED",
    })
  })

  it("still answers 500 when the cancel update fails for another reason", async () => {
    mockStore.cancelVoucher.mockResolvedValueOnce(false)
    expect((await cancel({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })).statusCode).toBe(500)
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

  it("answers 503 (not 403) when Blink is unavailable", async () => {
    blinkDown = true
    expect((await create()).statusCode).toBe(503)
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
      usdAmount: 100, // 100 cents = 2000 sats at the mocked 0.05 cents/sat
      amount: 2000,
    })
    expect(res.statusCode).toBe(200)
    expect(mockStore.createVoucher).toHaveBeenCalledWith(
      2000,
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

  // blink-wip#1665: the REST path must enforce the same balance check the
  // GraphQL create-withdraw-link path does, so the service never publishes
  // an ACTIVE voucher the wallet cannot back.
  describe("balance check (blink-wip#1665)", () => {
    it("rejects a BTC voucher above the wallet balance", async () => {
      const res = await create({ amount: 1001 }) // BTC wallet has 1000 sats
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: "Amount is more than the wallet balance" })
      expect(mockStore.createVoucher).not.toHaveBeenCalled()
    })

    it("accepts a voucher at exactly the wallet balance", async () => {
      expect((await create({ amount: 1000 })).statusCode).toBe(200)
      expect(mockStore.createVoucher).toHaveBeenCalled()
    })

    it("rejects a USD voucher above the wallet balance (cents vs cents)", async () => {
      const res = await create({
        walletId: "wallet-usd",
        walletCurrency: "USD",
        usdAmount: 501, // USD wallet has 500 cents
      })
      expect(res.statusCode).toBe(400)
      expect(mockStore.createVoucher).not.toHaveBeenCalled()
    })

    it("fails closed (503) when Blink omits the balance", async () => {
      setBlinkAccounts({
        [OWNER_KEY]: {
          [PROD]: [{ id: "wallet-1", walletCurrency: "BTC" } as never],
        },
      })
      expect((await create()).statusCode).toBe(503)
      expect(mockStore.createVoucher).not.toHaveBeenCalled()
    })
  })

  // The client supplies both denominations; the server must tie them together
  // with an authoritative rate, or a mismatched pair stores an ACTIVE voucher
  // advertising a value the USD amount doesn't back.
  describe("USD amount/sats pair cross-check", () => {
    const usd = (body: Record<string, unknown>) =>
      create({ walletId: "wallet-usd", walletCurrency: "USD", ...body })

    it("rejects the report's pair: 1 BTC advertised for 1 cent", async () => {
      const res = await usd({ amount: 100000000, usdAmount: 1 })
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({
        error: "amount does not match usdAmount at the current exchange rate",
      })
      expect(mockStore.createVoucher).not.toHaveBeenCalled()
    })

    it("rejects the inverse: sats far below the USD amount", async () => {
      // 500 cents = 10000 sats at the mocked rate; 100 sats is way off.
      const res = await usd({ amount: 100, usdAmount: 500 })
      expect(res.statusCode).toBe(400)
      expect(mockStore.createVoucher).not.toHaveBeenCalled()
    })

    it("accepts a pair within the 2% drift tolerance", async () => {
      // 100 cents = 2000 sats expected; 2040 is exactly +2%.
      expect((await usd({ amount: 2040, usdAmount: 100 })).statusCode).toBe(200)
      expect(mockStore.createVoucher).toHaveBeenCalled()
    })

    it("rejects a pair just outside the tolerance", async () => {
      expect((await usd({ amount: 2041, usdAmount: 100 })).statusCode).toBe(400)
      expect(mockStore.createVoucher).not.toHaveBeenCalled()
    })

    it("fails closed (503) when the rate cannot be verified", async () => {
      mockGetExchangeRate.mockRejectedValueOnce(new Error("rate unavailable"))
      expect((await usd({ amount: 2000, usdAmount: 100 })).statusCode).toBe(503)
      expect(mockStore.createVoucher).not.toHaveBeenCalled()
    })

    it("fails closed (503) on a malformed rate payload", async () => {
      mockGetExchangeRate.mockResolvedValueOnce({ satPriceInCurrency: 0 })
      expect((await usd({ amount: 2000, usdAmount: 100 })).statusCode).toBe(503)
    })

    it("never consults the rate for BTC vouchers", async () => {
      expect((await create({ amount: 500 })).statusCode).toBe(200)
      expect(mockGetExchangeRate).not.toHaveBeenCalled()
    })
  })
})

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
  markVoucherPaid: jest.fn(),
  cancelVoucher: jest.fn(),
  createVoucher: jest.fn(),
}
jest.mock("../../lib/voucher-store", () => ({
  __esModule: true,
  // Pure helper, kept real: the route maps SQLSTATE 55P03 to 503 with it.
  isLockTimeout: (err: unknown) => {
    const e = err as { code?: string; message?: string } | null
    return e?.code === "55P03" || /lock timeout/i.test(e?.message ?? "")
  },
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
    getWalletInfo: (signal?: AbortSignal) =>
      signal
        ? mockGetWalletInfo(apiKey, apiUrl, signal)
        : mockGetWalletInfo(apiKey, apiUrl),
    getExchangeRate: (currency: string, signal?: AbortSignal) =>
      signal
        ? mockGetExchangeRate(apiKey, apiUrl, currency, signal)
        : mockGetExchangeRate(apiKey, apiUrl, currency),
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
import { voucherTiebreak } from "../../lib/voucher-listing"
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
  mockStore.markVoucherPaid.mockResolvedValue(true)
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

  // Settled vouchers must leave the ACTIVE/CLAIMED liability aggregate —
  // Blink has already debited the wallet (PR #94 review). PENDING and
  // unknown outcomes stay CLAIMED (counted).
  it("marks the voucher PAID on SUCCESS", async () => {
    mockPayLnInvoice.mockResolvedValueOnce({ status: "SUCCESS" })
    const chargeId = "a".repeat(32)

    expect((await redeem(invoice({ sats: 500 }))).body).toEqual({ status: "OK" })
    expect(mockStore.markVoucherPaid).toHaveBeenCalledWith(chargeId)
  })

  it("still returns OK when the PAID write fails (payment already executed)", async () => {
    mockPayLnInvoice.mockResolvedValueOnce({ status: "SUCCESS" })
    mockStore.markVoucherPaid.mockResolvedValueOnce(false)

    expect((await redeem(invoice({ sats: 500 }))).body).toEqual({ status: "OK" })
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

  it("ALREADY_PAID (no net debit) releases the voucher and never clears its liability", async () => {
    // An exact-face-value invoice already paid elsewhere: Blink returns
    // ALREADY_PAID without a net debit on the voucher wallet. The voucher
    // must not become PAID (consumed unpaid, liability dropped); it is
    // released to ACTIVE so its holder can retry, and stays counted.
    mockPayLnInvoice.mockResolvedValueOnce({ status: "ALREADY_PAID" })
    const res = await redeem(invoice({ sats: 500 }))

    expect(res.body).toEqual({ status: "ERROR", reason: "Invoice has already been paid" })
    expect(mockStore.markVoucherPaid).not.toHaveBeenCalled()
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
    expect(mockStore.markVoucherPaid).not.toHaveBeenCalled()
  })

  it("never marks PAID on FAILURE, ALREADY_PAID or unknown outcomes", async () => {
    mockPayLnInvoice.mockResolvedValueOnce({ status: "FAILURE" })
    await redeem(invoice({ sats: 500 }))
    mockPayLnInvoice.mockResolvedValueOnce({ status: "ALREADY_PAID" })
    await redeem(invoice({ sats: 500 }))
    mockPayLnInvoice.mockResolvedValueOnce({ status: "WEIRD" })
    await redeem(invoice({ sats: 500 }))
    expect(mockStore.markVoucherPaid).not.toHaveBeenCalled()
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
      501, // no limit: 500 as before pagination (+1 to detect a next page)
      { before: null, status: undefined },
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

  it("?status= is passed to the store query (filtered in SQL, so older matches stay reachable)", async () => {
    // The SQL classification itself is tested on real Postgres
    // (tests/unit/pg/voucher-list-pages.pg.spec.ts).
    for (const [query, status] of [
      ["PAID", "PAID"],
      ["claimed", "CLAIMED"],
      ["ACTIVE", "ACTIVE"],
      ["all", undefined],
    ] as const) {
      mockStore.getVouchersByWalletIds.mockClear()
      await list({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY }, { status: query })
      expect(mockStore.getVouchersByWalletIds).toHaveBeenCalledWith(
        ["wallet-1", "wallet-usd"],
        "production",
        501,
        { before: null, status },
      )
    }
    const bad = await list(
      { [VOUCHER_API_KEY_HEADER]: OWNER_KEY },
      { status: "whatever" },
    )
    expect(bad.statusCode).toBe(400)
  })

  it("an omitted limit still returns up to 500 (older clients do not page)", async () => {
    const res = await list({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY })
    expect(res.statusCode).toBe(200)
    expect(mockStore.getVouchersByWalletIds).toHaveBeenCalledWith(
      ["wallet-1", "wallet-usd"],
      "production",
      501,
      { before: null, status: undefined },
    )
  })

  it("returns nextCursor when there are more vouchers than the page", async () => {
    mockStore.getVouchersByWalletIds.mockResolvedValue([
      voucher({ id: "a".repeat(32), createdAt: 3000 }),
      voucher({ id: "b".repeat(32), createdAt: 2000 }),
      voucher({ id: "c".repeat(32), createdAt: 1000 }),
    ])
    const res = await list({ [VOUCHER_API_KEY_HEADER]: OWNER_KEY }, { limit: "2" })
    const body = res.body as {
      vouchers: Array<{ id: string }>
      nextCursor: string
      truncated: boolean
    }
    expect(body.vouchers.map((v) => v.id[0])).toEqual(["a", "b"])
    // created_at + SHA-256 of the id: never the id (a redemption secret)
    expect(body.nextCursor).toBe(`2000_${voucherTiebreak("b".repeat(32))}`)
    expect(body.nextCursor).not.toContain("b".repeat(8))
    expect(body.truncated).toBe(true)

    await list(
      { [VOUCHER_API_KEY_HEADER]: OWNER_KEY },
      { limit: "2", before: body.nextCursor },
    )
    expect(mockStore.getVouchersByWalletIds).toHaveBeenLastCalledWith(
      ["wallet-1", "wallet-usd"],
      "production",
      3,
      {
        before: { createdAt: 2000, tiebreak: voucherTiebreak("b".repeat(32)) },
        status: undefined,
      },
    )
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
      501,
      { before: null, status: undefined },
    )
  })

  it("a replacement key for the same wallets sees the same vouchers", async () => {
    await list({ [VOUCHER_API_KEY_HEADER]: "blink_new_owner_key" })
    expect(mockStore.getVouchersByWalletIds).toHaveBeenCalledWith(
      ["wallet-1", "wallet-usd"],
      "production",
      501, // no limit: 500 as before pagination (+1 to detect a next page)
      { before: null, status: undefined },
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

  // What the store's locked transaction received from the route's backing()
  // callback (balance ceiling, liability, rate) — or null if it threw.
  let lastBacking: Record<string, unknown> | null = null
  let insertedCount = 0
  const inserted = () => insertedCount

  beforeEach(() => {
    lastBacking = null
    insertedCount = 0
    // Behaves like the store: runs backing() under its (mocked) wallet lock,
    // propagates a refusal thrown there, inserts otherwise.
    mockStore.createVoucher.mockImplementation(async (amount, _key, walletId, opts) => {
      lastBacking = await opts.backing()
      insertedCount++
      return {
        ...voucher({ amount, walletId }),
        walletCurrency: opts.walletCurrency,
        usdAmountCents: opts.usdAmount ?? null,
        expiryId: "24h",
        commissionPercent: 0,
      }
    })
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
    // Pre-check + the locked balance read, per create
    expect(mockGetWalletInfo).toHaveBeenCalledTimes(4)

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
      expect(inserted()).toBe(0)
    })

    it("accepts a voucher at exactly the wallet balance", async () => {
      expect((await create({ amount: 1000 })).statusCode).toBe(200)
      expect(inserted()).toBe(1)
      expect(lastBacking).toEqual({ maxLiabilityMinor: 1000, liabilityMinor: 1000 })
    })

    it("the ceiling is the balance read under the wallet lock, not the pre-check's", async () => {
      // The reviewer's race: between the route's pre-check and the locked
      // liability sum, a redemption settles (CLAIMED -> PAID) and debits the
      // wallet 1000 -> 400. The ceiling handed to the locked check must be
      // the post-debit 400, so a 1000-sat voucher is refused even though the
      // settled voucher has already left the liability aggregate.
      let reads = 0
      mockGetWalletInfo.mockImplementation(async () => {
        reads++
        return [{ ...BTC_WALLET, balance: reads === 1 ? 1000 : 400 }]
      })
      const res = await create({ amount: 1000 })
      expect(reads).toBe(2) // pre-check, then under the lock
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: "Amount is more than the wallet balance" })
      expect(inserted()).toBe(0)
    })

    describe("the locked critical section is bounded by ONE deadline", () => {
      // The store's lock_timeout is 15 s; a create must never hold the lock
      // longer than a concurrent settlement (markVoucherPaid) will wait.
      afterEach(() => jest.useRealTimers())

      it("fetches balance and rate concurrently (one round trip, not two)", async () => {
        let inFlight = 0
        let maxInFlight = 0
        const track = async <T>(value: T): Promise<T> => {
          maxInFlight = Math.max(maxInFlight, ++inFlight)
          await new Promise((r) => setTimeout(r, 5))
          inFlight--
          return value
        }
        let walletReads = 0
        mockGetWalletInfo.mockImplementation(async () =>
          ++walletReads === 1
            ? [BTC_WALLET, USD_WALLET]
            : track([BTC_WALLET, USD_WALLET]),
        )
        mockGetExchangeRate.mockImplementation(() =>
          track({ satPriceInCurrency: 0.05, currency: "USD" }),
        )
        const res = await create({
          walletId: "wallet-usd",
          walletCurrency: "USD",
          usdAmount: 100,
          amount: 2000,
        })
        expect(res.statusCode).toBe(200)
        expect(maxInFlight).toBe(2)
      })

      it("aborts the upstream requests and answers 503 when the deadline passes", async () => {
        jest.useFakeTimers()
        let walletReads = 0
        let lockedSignal: AbortSignal | undefined
        mockGetWalletInfo.mockImplementation(
          (_k: string, _u: string, signal?: AbortSignal) => {
            if (++walletReads === 1) return Promise.resolve([BTC_WALLET, USD_WALLET])
            lockedSignal = signal
            return new Promise(() => {}) // Blink hangs
          },
        )
        const pending = create({ amount: 500 })
        await jest.advanceTimersByTimeAsync(8_000)
        const res = await pending
        expect(res.statusCode).toBe(503)
        expect(lockedSignal?.aborted).toBe(true)
        expect(inserted()).toBe(0)
      })
    })

    it("fails closed (503) when the locked balance read is unavailable", async () => {
      let reads = 0
      mockGetWalletInfo.mockImplementation(async () => {
        if (++reads > 1) throw new Error("Blink API returned non-JSON response (502)")
        return [BTC_WALLET, USD_WALLET]
      })
      expect((await create({ amount: 500 })).statusCode).toBe(503)
      expect(inserted()).toBe(0)
    })

    it("rejects a USD voucher above the wallet balance (cents vs cents)", async () => {
      // Consistent pair (501 cents = 10020 sats at 0.05 cents/sat), but the
      // USD wallet holds only 500 cents.
      const res = await create({
        walletId: "wallet-usd",
        walletCurrency: "USD",
        usdAmount: 501,
        amount: 10020,
      })
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: "Amount is more than the wallet balance" })
      expect(inserted()).toBe(0)
    })

    it("fails closed (503) when Blink omits the balance", async () => {
      setBlinkAccounts({
        [OWNER_KEY]: {
          [PROD]: [{ id: "wallet-1", walletCurrency: "BTC" } as never],
        },
      })
      expect((await create()).statusCode).toBe(503)
      expect(inserted()).toBe(0)
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
      expect(inserted()).toBe(0)
    })

    it("rejects the inverse: sats far below the USD amount", async () => {
      // 500 cents = 10000 sats at the mocked rate; 100 sats is way off.
      const res = await usd({ amount: 100, usdAmount: 500 })
      expect(res.statusCode).toBe(400)
      expect(inserted()).toBe(0)
    })

    it("accepts a pair within tolerance (±1 cent quantization + 2% drift)", async () => {
      // 100 cents = 2000 sats expected; 2060 sats implies exactly 103 cents
      // (the +1 cent quantization + 2% = 3 cent boundary).
      expect((await usd({ amount: 2060, usdAmount: 100 })).statusCode).toBe(200)
      expect(mockStore.createVoucher).toHaveBeenCalled()
    })

    it("rejects a pair just outside the tolerance", async () => {
      // 2061 sats implies 103.05 cents — beyond the 3 cent allowance.
      expect((await usd({ amount: 2061, usdAmount: 100 })).statusCode).toBe(400)
      expect(inserted()).toBe(0)
    })

    it("applies the tolerance in the negative direction too", async () => {
      // 1939 sats implies 96.95 cents — 3.05 below the supplied 100 cents.
      expect((await usd({ amount: 1939, usdAmount: 100 })).statusCode).toBe(400)
    })

    it("accepts an honest small pair the sats-space check would quantize away", async () => {
      // Production client formula: round(15 sats * 0.05) = 1 cent. The server
      // must not reconstruct 1 / 0.05 = 20 sats and cry 25% drift.
      expect((await usd({ amount: 15, usdAmount: 1 })).statusCode).toBe(200)
      expect(mockStore.createVoucher).toHaveBeenCalled()
    })

    it("the pair tolerance cannot weaken backing", async () => {
      // Wallet holds exactly 100 cents; 2039 sats is within pair tolerance
      // (101.95 implied cents) but costs 102 cents at the same rate.
      setBlinkAccounts({
        [OWNER_KEY]: {
          [PROD]: [{ id: "wallet-usd", walletCurrency: "USD", balance: 100 }],
        },
      })
      const res = await usd({ amount: 2039, usdAmount: 100 })
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: "Amount is more than the wallet balance" })
      expect(inserted()).toBe(0)
    })

    it("fails closed (503) when the rate cannot be verified", async () => {
      mockGetExchangeRate.mockRejectedValueOnce(new Error("rate unavailable"))
      expect((await usd({ amount: 2000, usdAmount: 100 })).statusCode).toBe(503)
      expect(inserted()).toBe(0)
    })

    it("fails closed (503) on a malformed rate payload", async () => {
      mockGetExchangeRate.mockResolvedValueOnce({ satPriceInCurrency: 0 })
      expect((await usd({ amount: 2000, usdAmount: 100 })).statusCode).toBe(503)
    })

    it("never consults the rate for BTC vouchers", async () => {
      expect((await create({ amount: 500 })).statusCode).toBe(200)
      expect(mockGetExchangeRate).not.toHaveBeenCalled()
    })

    it("fetches the rate for the voucher's environment (staging)", async () => {
      setBlinkAccounts({
        [OWNER_KEY]: {
          [STAGING]: [{ id: "wallet-stg-usd", walletCurrency: "USD", balance: 1000 }],
        },
      })
      const res = await create({
        walletId: "wallet-stg-usd",
        walletCurrency: "USD",
        usdAmount: 100,
        amount: 2000,
        environment: "staging",
      })
      expect(res.statusCode).toBe(200)
      // ...under the locked backing deadline's abort signal
      expect(mockGetExchangeRate).toHaveBeenCalledWith(
        OWNER_KEY,
        STAGING,
        "USD",
        expect.any(AbortSignal),
      )
    })

    it("passes the conservative liability AND the rate to the store, so the next voucher re-rates this one", async () => {
      // 2060 sats at 0.05 cents/sat: stored display value is 100 cents, but
      // the conservative liability is 103 cents. The store must receive both
      // the override and the rate, or the next create would sum the smaller
      // persisted cents and undercount the aggregate (PR #94 re-review).
      const res = await usd({ amount: 2060, usdAmount: 100 })
      expect(res.statusCode).toBe(200)
      expect(mockStore.createVoucher).toHaveBeenCalledWith(
        2060,
        OWNER_KEY,
        "wallet-usd",
        expect.objectContaining({ usdAmount: 100, backing: expect.any(Function) }),
      )
      // ...delivered through the locked backing() callback
      expect(lastBacking).toEqual({
        liabilityMinor: 103,
        maxLiabilityMinor: 500,
        usdCentsPerSat: 0.05,
      })
    })

    it("maps a wallet-lock timeout (SQLSTATE 55P03) to a retryable 503, not 500", async () => {
      // Several slow same-wallet creates queued past lock_timeout: the store
      // rolled back safely, so the client should simply retry.
      mockStore.createVoucher.mockRejectedValueOnce(
        Object.assign(new Error("canceling statement due to lock timeout"), {
          code: "55P03",
        }),
      )
      const res = await create({ amount: 500 })
      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }))
    })

    it("maps the store's aggregate-liability refusal to 400", async () => {
      // Sequential create: the first voucher's liabilities already consumed
      // the balance, the locked aggregate check refuses the second.
      mockStore.createVoucher.mockRejectedValueOnce(
        new Error("Voucher amount exceeds the wallet balance"),
      )
      expect((await create({ amount: 900 })).statusCode).toBe(400)
    })
  })
})

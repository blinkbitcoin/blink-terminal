/**
 * Tests for POST /api/blink/create-invoice — DIRECT (no-escrow) mode.
 *
 * With the intermediate BlinkPOS account removed, the authed POS mints invoices
 * directly on the merchant's own wallet. These tests assert the direct path for
 * each merchant type and that NO escrow forwarding record is stored.
 *
 * The escrow path is gated behind isSplitPaymentsEnabled() (mocked false here).
 */

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (h: unknown) => h,
  RATE_LIMIT_WRITE: { max: 30 },
}))

jest.mock("../../lib/config/api", () => ({
  getApiUrlForEnvironment: () => "https://api.blink.test/graphql",
}))

// Split Payments disabled -> direct (no-escrow) path.
const mockSplitEnabled = jest.fn(() => false)
jest.mock("../../lib/config/features", () => ({
  isSplitPaymentsEnabled: () => mockSplitEnabled(),
}))

// Tracing: run the span body directly.
jest.mock("../../lib/tracing", () => ({
  getTracer: () => ({}),
  withSpan: (_t: unknown, _n: string, fn: (span: unknown) => unknown) =>
    fn({ setAttribute: () => {} }),
  getActiveTraceId: () => "trace-test",
}))

// LNURL invoice creation (Blink LN-address + npub.cash paths).
const mockGetInvoice = jest.fn()
jest.mock("../../lib/lnurl", () => ({
  getInvoiceFromLightningAddress: (...a: unknown[]) => mockGetInvoice(...a),
}))

// BlinkAPI: constructor + createLnInvoice (API-key merchant path).
const mockCreateLnInvoice = jest.fn()
jest.mock("../../lib/blink-api", () => ({
  __esModule: true,
  default: class {
    createLnInvoice = (...a: unknown[]) => mockCreateLnInvoice(...a)
  },
}))

// NWCClient: make_invoice on the merchant wallet.
const mockMakeInvoice = jest.fn()
const mockClose = jest.fn()
jest.mock("../../lib/nwc/NWCClient", () => ({
  __esModule: true,
  default: class {
    makeInvoice = (...a: unknown[]) => mockMakeInvoice(...a)
    close = () => mockClose()
  },
}))

// Hybrid store: assert storeTipData is NEVER called in direct mode.
const mockStoreTipData = jest.fn()
jest.mock("../../lib/storage/hybrid-store", () => ({
  getHybridStore: async () => ({
    storeTipData: (...a: unknown[]) => mockStoreTipData(...a),
  }),
}))

// Auth (encryptApiKey) — unused in direct mode but imported by the handler.
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { encryptApiKey: (s: string) => `enc:${s}` },
}))

import handler from "../../pages/api/blink/create-invoice"

function mockReqRes(body: unknown, method = "POST") {
  const req = { method, body, headers: {}, socket: {} } as NextApiRequest
  const res = {
    _status: 200,
    _json: null as any,
    _headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this._headers[k] = v
    },
    status(code: number) {
      this._status = code
      return this
    },
    json(payload: unknown) {
      this._json = payload
      return this
    },
  }
  return {
    req,
    res: res as unknown as NextApiResponse & {
      _status: number
      _json: any
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSplitEnabled.mockReturnValue(false)
  mockGetInvoice.mockResolvedValue({
    paymentRequest: "lnbc-lnurl",
    paymentHash: "hashlnurl",
    verify: "https://blink.sv/verify/hashlnurl",
  })
  mockCreateLnInvoice.mockResolvedValue({
    paymentRequest: "lnbc-apikey",
    paymentHash: "hashapikey",
    satoshis: 5000,
  })
  mockMakeInvoice.mockResolvedValue({
    result: { invoice: "lnbc-nwc", payment_hash: "hashnwc" },
    error: null,
  })
})

describe("create-invoice (direct mode)", () => {
  it("rejects non-POST", async () => {
    const { req, res } = mockReqRes({}, "GET")
    await handler(req, res)
    expect(res._status).toBe(405)
  })

  it("API-key merchant: mints on the merchant's own wallet, no escrow record", async () => {
    const { req, res } = mockReqRes({
      amount: 5000,
      currency: "BTC",
      apiKey: "merchant-key",
      userWalletId: "merchant-wallet",
      memo: "test",
    })
    await handler(req, res)

    expect(res._status).toBe(200)
    expect(res._json.invoice).toMatchObject({
      paymentRequest: "lnbc-apikey",
      paymentHash: "hashapikey",
    })
    expect(mockCreateLnInvoice).toHaveBeenCalledWith("merchant-wallet", 5000, "test")
    expect(res._json.invoice.verifyUrl).toBeUndefined()
    expect(mockStoreTipData).not.toHaveBeenCalled()
  })

  it("Blink LN-address merchant: mints via LNURL and returns verifyUrl", async () => {
    const { req, res } = mockReqRes({
      amount: 5000,
      currency: "BTC",
      blinkLnAddress: true,
      blinkLnAddressUsername: "merchant",
    })
    await handler(req, res)

    expect(res._status).toBe(200)
    expect(res._json.invoice).toMatchObject({
      paymentRequest: "lnbc-lnurl",
      verifyUrl: "https://blink.sv/verify/hashlnurl",
    })
    expect(mockGetInvoice).toHaveBeenCalledWith("merchant@blink.sv", 5000, "")
    expect(mockStoreTipData).not.toHaveBeenCalled()
  })

  it("npub.cash merchant: mints via LNURL against the given address", async () => {
    const { req, res } = mockReqRes({
      amount: 3000,
      currency: "BTC",
      npubCashActive: true,
      npubCashLightningAddress: "user@npub.cash",
    })
    await handler(req, res)

    expect(res._status).toBe(200)
    expect(mockGetInvoice).toHaveBeenCalledWith("user@npub.cash", 3000, "")
    expect(mockStoreTipData).not.toHaveBeenCalled()
  })

  it("NWC merchant: make_invoice on the merchant wallet (millisats) + closes client", async () => {
    const { req, res } = mockReqRes({
      amount: 2000,
      currency: "BTC",
      nwcActive: true,
      nwcConnectionUri: "nostr+walletconnect://abc",
    })
    await handler(req, res)

    expect(res._status).toBe(200)
    expect(res._json.invoice).toMatchObject({
      paymentRequest: "lnbc-nwc",
      paymentHash: "hashnwc",
    })
    expect(mockMakeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2_000_000 }),
    )
    expect(mockClose).toHaveBeenCalled()
    expect(mockStoreTipData).not.toHaveBeenCalled()
  })

  it("rejects when no merchant destination is provided", async () => {
    const { req, res } = mockReqRes({ amount: 1000, currency: "BTC" })
    await handler(req, res)
    expect(res._status).toBe(400)
  })

  it("rejects amounts above the 0.1 BTC cap", async () => {
    const { req, res } = mockReqRes({
      amount: 10_000_001,
      currency: "BTC",
      apiKey: "k",
      userWalletId: "w",
    })
    await handler(req, res)
    expect(res._status).toBe(400)
  })

  it("returns 502 when merchant invoice creation fails", async () => {
    mockCreateLnInvoice.mockRejectedValue(new Error("merchant wallet error"))
    const { req, res } = mockReqRes({
      amount: 5000,
      currency: "BTC",
      apiKey: "k",
      userWalletId: "w",
    })
    await handler(req, res)
    expect(res._status).toBe(502)
  })
})

/**
 * Security regression tests for POST /api/blink/pay-invoice
 *
 * Drain vector (pre-fix): the endpoint paid ANY client-supplied BOLT11 from the
 * house wallet as long as a pending paymentHash existed — the invoice amount was
 * never bound to the stored base amount.
 *
 * Post-fix invariants verified here:
 *   - paymentHash is mandatory.
 *   - The stored record must exist and be in `processing`.
 *   - The invoice must pass verifyForwardInvoice against the stored base amount
 *     (exact amount + Blink node).
 */

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (h: unknown) => h,
  RATE_LIMIT_WRITE: { max: 30 },
}))

const mockPayLnInvoice = jest.fn()
jest.mock("../../lib/blink-api", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ payLnInvoice: mockPayLnInvoice })),
}))

const mockGetTipData = jest.fn()
const mockReleaseFailedClaim = jest.fn()
const mockLogEvent = jest.fn()
jest.mock("../../lib/storage/hybrid-store", () => ({
  getHybridStore: jest.fn(async () => ({
    getTipData: mockGetTipData,
    releaseFailedClaim: mockReleaseFailedClaim,
    logEvent: mockLogEvent,
  })),
}))

jest.mock("../../lib/config/api", () => ({
  getApiUrlForEnvironment: () => "https://api.blink.test/graphql",
}))

type GuardRet = { ok: true } | { ok: false; error: string }
const mockAssertMax = jest.fn((): GuardRet => ({ ok: true }))
const mockVerifyInvoice = jest.fn((): GuardRet => ({ ok: true }))
jest.mock("../../lib/payout-guard", () => ({
  assertWithinMaxForward: (...a: unknown[]) => mockAssertMax(...(a as [])),
  verifyForwardInvoice: (...a: unknown[]) => mockVerifyInvoice(...(a as [])),
}))

import handler from "../../pages/api/blink/pay-invoice"

const VALID_HASH = "b".repeat(64)
const INVOICE = "lnbc10n1validinvoice"

function mockReqRes(body: unknown) {
  const req = { method: "POST", body, headers: {}, socket: {} } as NextApiRequest
  const res = {
    _status: 200,
    _json: null as any,
    status(code: number) {
      this._status = code
      return this
    },
    json(payload: unknown) {
      this._json = payload
      return this
    },
  }
  return { req, res: res as unknown as NextApiResponse & { _status: number; _json: any } }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.BLINKPOS_API_KEY = "house-key"
  process.env.BLINKPOS_BTC_WALLET_ID = "house-wallet"
  mockPayLnInvoice.mockResolvedValue({ status: "SUCCESS" })
  mockAssertMax.mockReturnValue({ ok: true })
  mockVerifyInvoice.mockReturnValue({ ok: true })
})

describe("pay-invoice security", () => {
  it("rejects missing paymentHash", async () => {
    const { req, res } = mockReqRes({ invoice: INVOICE })
    await handler(req, res)
    expect(res._status).toBe(401)
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })

  it("rejects unknown payment", async () => {
    mockGetTipData.mockResolvedValue(null)
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH, invoice: INVOICE })
    await handler(req, res)
    expect(res._status).toBe(401)
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })

  it("rejects a payment not in processing state", async () => {
    mockGetTipData.mockResolvedValue({ status: "pending", baseAmount: 1000 })
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH, invoice: INVOICE })
    await handler(req, res)
    expect(res._status).toBe(409)
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })

  it("DRAIN VECTOR: rejects an invoice that fails amount/Blink-node verification", async () => {
    mockGetTipData.mockResolvedValue({ status: "processing", baseAmount: 1000 })
    mockVerifyInvoice.mockReturnValue({
      ok: false,
      error: "Invoice amount (1000000 sats) does not match expected amount (1000 sats)",
    })
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH, invoice: INVOICE })
    await handler(req, res)
    expect(res._status).toBe(400)
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
    // Verified against the STORED base amount.
    expect(mockVerifyInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSats: 1000, requireBlinkNode: true }),
    )
  })

  it("pays only when status=processing and verification passes", async () => {
    mockGetTipData.mockResolvedValue({ status: "processing", baseAmount: 1000 })
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH, invoice: INVOICE })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(mockPayLnInvoice).toHaveBeenCalledWith(
      "house-wallet",
      INVOICE,
      expect.any(String),
    )
  })

  it("is idempotent for completed payments", async () => {
    mockGetTipData.mockResolvedValue({ status: "completed", baseAmount: 1000 })
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH, invoice: INVOICE })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(res._json.alreadyProcessed).toBe(true)
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })
})

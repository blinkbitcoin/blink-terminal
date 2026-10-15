/**
 * Security regression tests for POST /api/blink/forward-npubcash
 *
 * Drain vectors (pre-fix):
 *   1. Claim wrapped in `if (paymentHash)` — omitting it bypassed dedup.
 *   2. recipientAddress + totalAmount came from the request body.
 *
 * Post-fix invariants:
 *   - paymentHash mandatory (401 when missing).
 *   - recipient + base amount come from the claimed stored record.
 *   - invoice verified against stored base amount + Blink node.
 */

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (h: unknown) => h,
  RATE_LIMIT_WRITE: { max: 30 },
}))

const mockPayLnInvoice = jest.fn()
const mockSendTipViaInvoice = jest.fn()
jest.mock("../../lib/blink-api", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    payLnInvoice: mockPayLnInvoice,
    sendTipViaInvoice: mockSendTipViaInvoice,
  })),
}))

const mockClaim = jest.fn()
const mockRemoveTipData = jest.fn()
const mockReleaseFailedClaim = jest.fn()
const mockLogEvent = jest.fn()
jest.mock("../../lib/storage/hybrid-store", () => ({
  getHybridStore: jest.fn(async () => ({
    claimPaymentForProcessing: mockClaim,
    removeTipData: mockRemoveTipData,
    releaseFailedClaim: mockReleaseFailedClaim,
    logEvent: mockLogEvent,
  })),
}))

jest.mock("../../lib/config/api", () => ({
  getApiUrlForEnvironment: () => "https://api.blink.test/graphql",
}))

const mockVerifyInvoice = jest.fn(() => ({ ok: true }))
jest.mock("../../lib/payout-guard", () => ({
  assertWithinMaxForward: jest.fn(() => ({ ok: true })),
  verifyForwardInvoice: (...a: unknown[]) => mockVerifyInvoice(...(a as [])),
}))

const mockGetInvoiceFromLnAddr = jest.fn(async () => ({
  paymentRequest: "lnbc-npubcash-invoice",
  metadata: { minSendable: 1000, maxSendable: 100000000 },
}))
jest.mock("../../lib/lnurl", () => ({
  getInvoiceFromLightningAddress: (...a: unknown[]) =>
    mockGetInvoiceFromLnAddr(...(a as [])),
}))

import handler from "../../pages/api/blink/forward-npubcash"

const VALID_HASH = "d".repeat(64)

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
  mockVerifyInvoice.mockReturnValue({ ok: true })
})

describe("forward-npubcash security", () => {
  it("is disabled: 410 and no payout", async () => {
    const { req, res } = mockReqRes({
      paymentHash: VALID_HASH,
      totalAmount: 9_999_999,
      recipientAddress: "npub1attacker@npub.cash",
    })
    await handler(req, res)
    expect(res._status).toBe(410)
    expect(mockGetInvoiceFromLnAddr).not.toHaveBeenCalled()
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })
})

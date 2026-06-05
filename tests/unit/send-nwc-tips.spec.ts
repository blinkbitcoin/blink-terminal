/**
 * Security regression tests for POST /api/blink/send-nwc-tips
 *
 * Drain vector (pre-fix): tip amount + recipients were taken from the request
 * body and paid from the BlinkPOS house wallet with no claim/validation, making
 * the endpoint an unauthenticated, replayable wallet drain.
 *
 * Post-fix invariants verified here:
 *   - Tip amount + recipients come ONLY from the stored payment record.
 *   - A client-supplied `tipData` in the body is ignored.
 *   - The stored record must be in `processing` state.
 *   - Unknown / completed / wrong-state payments are rejected.
 */

import type { NextApiRequest, NextApiResponse } from "next"

// --- Mocks -----------------------------------------------------------------

// Pass-through rate limiter (no Redis in unit tests).
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

const mockGetTipData = jest.fn()
const mockRemoveTipData = jest.fn()
const mockLogEvent = jest.fn()
jest.mock("../../lib/storage/hybrid-store", () => ({
  getHybridStore: jest.fn(async () => ({
    getTipData: mockGetTipData,
    removeTipData: mockRemoveTipData,
    logEvent: mockLogEvent,
  })),
}))

jest.mock("../../lib/config/api", () => ({
  getApiUrlForEnvironment: () => "https://api.blink.test/graphql",
}))

// Let payout-guard run for real where possible, but stub invoice verification
// so we don't need to craft signed BOLT11 in these route tests.
jest.mock("../../lib/payout-guard", () => ({
  assertWithinMaxForward: jest.fn(() => ({ ok: true })),
  verifyForwardInvoice: jest.fn(() => ({ ok: true })),
}))

jest.mock("../../lib/lnurl", () => ({
  getInvoiceFromLightningAddress: jest.fn(async () => ({
    paymentRequest: "lnbc-recipient-invoice",
  })),
  isNpubCashAddress: () => false,
}))

import handler from "../../pages/api/blink/send-nwc-tips"

const VALID_HASH = "a".repeat(64)

function mockReqRes(body: unknown) {
  const req = { method: "POST", body, headers: {}, socket: {} } as NextApiRequest
  const res = {
    _status: 200,
    _json: null as unknown,
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
  mockPayLnInvoice.mockResolvedValue({ status: "SUCCESS", paymentHash: "x" })
  mockSendTipViaInvoice.mockResolvedValue({ status: "SUCCESS", paymentHash: "x" })
})

describe("send-nwc-tips security", () => {
  it("rejects a missing/invalid paymentHash", async () => {
    const { req, res } = mockReqRes({ tipData: { tipAmount: 5000 } })
    await handler(req, res)
    expect(res._status).toBe(400)
    expect(mockSendTipViaInvoice).not.toHaveBeenCalled()
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })

  it("DRAIN VECTOR: ignores client-supplied tipData; uses stored amount/recipients", async () => {
    // Stored record says: 100 sat tip to honest-merchant, in processing state.
    mockGetTipData.mockResolvedValue({
      status: "processing",
      tipAmount: 100,
      tipRecipients: [{ username: "honest-merchant", share: 100 }],
      displayCurrency: "BTC",
      environment: "production",
    })

    // Attacker tries to inject a huge tip to themselves via the body.
    const { req, res } = mockReqRes({
      paymentHash: VALID_HASH,
      tipData: {
        tipAmount: 5_000_000,
        tipRecipients: [{ username: "attacker", share: 100 }],
      },
    })
    await handler(req, res)

    expect(res._status).toBe(200)
    // Paid the STORED 100 sats to the STORED recipient — not the body's values.
    expect(mockSendTipViaInvoice).toHaveBeenCalledTimes(1)
    expect(mockSendTipViaInvoice).toHaveBeenCalledWith(
      "house-wallet",
      "honest-merchant",
      100,
      expect.any(String),
    )
    // Marks complete (replay protection).
    expect(mockRemoveTipData).toHaveBeenCalledWith(VALID_HASH)
  })

  it("rejects when the stored payment is not found", async () => {
    mockGetTipData.mockResolvedValue(null)
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH })
    await handler(req, res)
    expect(res._status).toBe(404)
    expect(mockSendTipViaInvoice).not.toHaveBeenCalled()
  })

  it("is idempotent for already-completed payments (no double payout)", async () => {
    mockGetTipData.mockResolvedValue({ status: "completed", tipAmount: 100 })
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(res._json.alreadyProcessed).toBe(true)
    expect(mockSendTipViaInvoice).not.toHaveBeenCalled()
  })

  it("rejects a payment still in pending (not claimed by base forward)", async () => {
    mockGetTipData.mockResolvedValue({ status: "pending", tipAmount: 100 })
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH })
    await handler(req, res)
    expect(res._status).toBe(409)
    expect(mockSendTipViaInvoice).not.toHaveBeenCalled()
  })
})

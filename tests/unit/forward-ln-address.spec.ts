/**
 * Security regression tests for POST /api/blink/forward-ln-address
 *
 * Drain vectors (pre-fix):
 *   1. The atomic claim was wrapped in `if (paymentHash)`, so omitting
 *      paymentHash skipped duplicate-payout protection entirely.
 *   2. recipient (username/walletId) and amount came from the request body.
 *
 * Post-fix invariants verified here:
 *   - paymentHash is mandatory (401 when missing/invalid).
 *   - recipient + base amount come from the claimed stored record only.
 *   - a not_found claim never pays out.
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

jest.mock("../../lib/lnurl", () => ({
  getInvoiceFromLightningAddress: jest.fn(async () => ({
    paymentRequest: "lnbc-tip-invoice",
  })),
}))

import handler from "../../pages/api/blink/forward-ln-address"

const VALID_HASH = "c".repeat(64)

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
  mockSendTipViaInvoice.mockResolvedValue({ status: "SUCCESS" })
  mockVerifyInvoice.mockReturnValue({ ok: true })

  // Wallet lookup + invoice-on-behalf both go through global.fetch.
  global.fetch = jest.fn(async () => ({
    json: async () => ({
      data: {
        accountDefaultWallet: { id: "stored-btc-wallet", walletCurrency: "BTC" },
        lnInvoiceCreateOnBehalfOfRecipient: {
          errors: [],
          invoice: {
            paymentHash: "deadbeef",
            paymentRequest: "lnbc-recipient-invoice",
            satoshis: 1000,
          },
        },
      },
    }),
  })) as unknown as typeof fetch
})

describe("forward-ln-address security", () => {
  it("DRAIN VECTOR: rejects a request with no paymentHash (no claim bypass)", async () => {
    const { req, res } = mockReqRes({
      totalAmount: 5_000_000,
      recipientUsername: "attacker",
      recipientWalletId: "attacker-wallet",
    })
    await handler(req, res)
    expect(res._status).toBe(401)
    expect(mockClaim).not.toHaveBeenCalled()
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })

  it("does not pay out when claim returns not_found", async () => {
    mockClaim.mockResolvedValue({
      claimed: false,
      reason: "not_found",
      paymentData: null,
    })
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH })
    await handler(req, res)
    expect(res._json.skipForwarding).toBe(true)
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })

  it("DRAIN VECTOR: ignores client recipient/amount; uses stored values", async () => {
    mockClaim.mockResolvedValue({
      claimed: true,
      reason: "success",
      paymentData: {
        baseAmount: 1000,
        tipAmount: 0,
        tipRecipients: [],
        displayCurrency: "BTC",
        environment: "production",
        blinkLnAddressUsername: "honest-merchant",
        blinkLnAddressWalletId: "stored-btc-wallet",
      },
    })

    const { req, res } = mockReqRes({
      paymentHash: VALID_HASH,
      // Hostile values that must be ignored:
      totalAmount: 9_999_999,
      recipientUsername: "attacker",
      recipientWalletId: "attacker-wallet",
    })
    await handler(req, res)

    expect(res._status).toBe(200)
    // Invoice-on-behalf was verified against the STORED base amount (1000).
    expect(mockVerifyInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSats: 1000, requireBlinkNode: true }),
    )
    // Base amount paid exactly once from the house wallet.
    expect(mockPayLnInvoice).toHaveBeenCalledTimes(1)
    expect(mockPayLnInvoice).toHaveBeenCalledWith(
      "house-wallet",
      "lnbc-recipient-invoice",
      expect.any(String),
    )
    // Completed -> replay safe.
    expect(mockRemoveTipData).toHaveBeenCalledWith(VALID_HASH)
  })

  it("returns idempotent success when already completed", async () => {
    mockClaim.mockResolvedValue({
      claimed: false,
      reason: "already_completed",
      paymentData: null,
    })
    const { req, res } = mockReqRes({ paymentHash: VALID_HASH })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(res._json.alreadyProcessed).toBe(true)
    expect(mockPayLnInvoice).not.toHaveBeenCalled()
  })
})

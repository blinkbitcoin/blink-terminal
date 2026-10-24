/** @jest-environment node */

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { decryptApiKey: jest.fn() },
}))

jest.mock("../../lib/webhook-verify", () => ({
  verifyWebhookSignature: () => true,
}))

jest.mock("../../lib/tracing", () => ({
  getTracer: () => ({}),
  withSpan: async (
    _tracer: unknown,
    _name: string,
    fn: (span: { setAttribute: () => void }) => Promise<unknown>,
  ) => fn({ setAttribute: () => {} }),
  getActiveTraceId: () => null,
}))

jest.mock("../../lib/boltcard/lnurlp", () => ({
  getPendingTopUp: jest.fn(async () => null),
  processTopUpPayment: jest.fn(),
}))

const mockClaim = jest.fn()
const mockUpdatePaymentStatus = jest.fn()
const mockLogEvent = jest.fn()
const mockReleaseFailedClaim = jest.fn()
const mockRemoveTipData = jest.fn()
jest.mock("../../lib/storage/hybrid-store", () => ({
  getHybridStore: jest.fn(async () => ({
    claimPaymentForProcessing: mockClaim,
    updatePaymentStatus: mockUpdatePaymentStatus,
    logEvent: mockLogEvent,
    releaseFailedClaim: mockReleaseFailedClaim,
    removeTipData: mockRemoveTipData,
  })),
}))

const mockGetInvoice = jest.fn()
jest.mock("../../lib/lnurl", () => ({
  getInvoiceFromLightningAddress: (...args: unknown[]) => mockGetInvoice(...args),
}))

jest.mock("../../lib/blink-api", () => ({
  __esModule: true,
  default: jest.fn(),
}))

jest.mock("../../lib/nwc/NWCClient", () => ({
  __esModule: true,
  default: jest.fn(),
}))

import BlinkAPI from "../../lib/blink-api"
import handler from "../../pages/api/blink/webhook"

const PAYMENT_HASH = "a".repeat(64)

function mockReqRes(body: unknown) {
  const req = { method: "POST", body, headers: {} } as NextApiRequest
  const res = {
    _status: 200,
    _json: null as { status?: string } | null,
    setHeader: jest.fn(),
    status(code: number) {
      this._status = code
      return this
    },
    json(payload: { status?: string }) {
      this._json = payload
      return this
    },
  }
  return {
    req,
    res: res as unknown as NextApiResponse & {
      _status: number
      _json: { status?: string } | null
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.BLINK_WEBHOOK_SECRET = "test-secret"
  mockUpdatePaymentStatus.mockResolvedValue(undefined)
  mockLogEvent.mockResolvedValue(undefined)
  mockClaim.mockResolvedValue({
    claimed: true,
    reason: "success",
    paymentData: {
      baseAmount: 1000,
      metadata: {
        npubCashActive: true,
        npubCashLightningAddress: "user@npub.cash",
      },
    },
  })
})

describe("webhook npub.cash", () => {
  it("does not pay or report a delayed npub.cash invoice as forwarded", async () => {
    const { req, res } = mockReqRes({
      eventType: "receive.lightning",
      transaction: {
        status: "success",
        settlementAmount: 1000,
        initiationVia: { paymentHash: PAYMENT_HASH },
      },
    })

    await handler(req, res)

    expect(res._status).toBe(200)
    expect(res._json?.status).toBe("npub_cash_unavailable")
    expect(res._json?.status).not.toBe("forwarded")
    expect(mockUpdatePaymentStatus).toHaveBeenCalledWith(PAYMENT_HASH, "failed", {
      reason: "npub_cash_unavailable",
    })
    expect(mockLogEvent).toHaveBeenCalledWith(
      PAYMENT_HASH,
      "webhook_forward",
      "failed",
      expect.objectContaining({ error: expect.any(String) }),
    )
    expect(mockReleaseFailedClaim).not.toHaveBeenCalled()
    expect(mockRemoveTipData).not.toHaveBeenCalled()
    expect(mockGetInvoice).not.toHaveBeenCalled()
    expect(BlinkAPI).not.toHaveBeenCalled()
  })
})

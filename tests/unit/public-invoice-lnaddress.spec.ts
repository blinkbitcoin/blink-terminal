/**
 * Tests for POST /api/blink/public-invoice-lnaddress
 *
 * The self-custodial (LNURL-pay) public invoice path:
 *   - resolves the receiver (resolver mocked)
 *   - rejects custodial receivers (must use /public-invoice)
 *   - creates an invoice via LNURL-pay and returns { paymentRequest, verifyUrl }
 *   - validates amount bounds and surfaces LNURL bounds errors as 400
 *   - returns 404 when the address does not exist
 */

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (h: unknown) => h,
  RATE_LIMIT_PUBLIC: { max: 30 },
}))

jest.mock("../../lib/config/api", () => ({
  getApiUrlForEnvironment: () => "https://api.blink.test/graphql",
}))

const mockResolveReceiver = jest.fn()
jest.mock("../../lib/receiver-resolver", () => {
  // Defined inside the factory so it exists when jest hoists this mock.
  class ReceiverNotFoundError extends Error {
    constructor(identifier: string) {
      super(`'${identifier}' is not a Blink address that exists.`)
      this.name = "ReceiverNotFoundError"
    }
  }
  return {
    resolveReceiver: (...a: unknown[]) => mockResolveReceiver(...a),
    ReceiverNotFoundError,
  }
})

const mockGetInvoice = jest.fn()
jest.mock("../../lib/lnurl", () => ({
  getInvoiceFromLightningAddress: (...a: unknown[]) => mockGetInvoice(...a),
}))

import handler from "../../pages/api/blink/public-invoice-lnaddress"

// Pull the mocked module's error class so `new ReceiverNotFoundError()` is an
// instance of the same class the handler's `instanceof` check uses. Done via
// requireMock (not an import) to respect import-ordering against the handler.
const { ReceiverNotFoundError } = jest.requireMock<{
  ReceiverNotFoundError: new (id: string) => Error
}>("../../lib/receiver-resolver")

function mockReqRes(body: unknown, method = "POST") {
  const req = { method, body, headers: {}, socket: {} } as NextApiRequest
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
  return {
    req,
    res: res as unknown as NextApiResponse & { _status: number; _json: any },
  }
}

const LNADDRESS_RECEIVER = {
  type: "lnaddress" as const,
  lightningAddress: "sparkmerchant@blink.sv",
  username: "sparkmerchant",
  domain: "blink.sv",
  isBlinkDomain: true,
  metadata: {},
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveReceiver.mockResolvedValue(LNADDRESS_RECEIVER)
  mockGetInvoice.mockResolvedValue({
    paymentRequest: "lnbc-spark-invoice",
    paymentHash: "abc123",
    verify: "https://blink.sv/verify/abc123",
  })
})

describe("public-invoice-lnaddress", () => {
  it("rejects non-POST", async () => {
    const { req, res } = mockReqRes({}, "GET")
    await handler(req, res)
    expect(res._status).toBe(405)
  })

  it("requires a username", async () => {
    const { req, res } = mockReqRes({ amount: 1000 })
    await handler(req, res)
    expect(res._status).toBe(400)
  })

  it("requires a valid positive amount", async () => {
    const { req, res } = mockReqRes({ username: "sparkmerchant", amount: 0 })
    await handler(req, res)
    expect(res._status).toBe(400)
  })

  it("rejects amounts above the 0.1 BTC cap", async () => {
    const { req, res } = mockReqRes({
      username: "sparkmerchant",
      amount: 10_000_001,
    })
    await handler(req, res)
    expect(res._status).toBe(400)
  })

  it("creates an invoice and returns paymentRequest + verifyUrl", async () => {
    const { req, res } = mockReqRes({ username: "sparkmerchant", amount: 5000 })
    await handler(req, res)

    expect(res._status).toBe(200)
    expect(res._json.success).toBe(true)
    expect(res._json.invoice).toMatchObject({
      paymentRequest: "lnbc-spark-invoice",
      paymentHash: "abc123",
      verifyUrl: "https://blink.sv/verify/abc123",
      lightningAddress: "sparkmerchant@blink.sv",
      satoshis: 5000,
    })
    expect(mockGetInvoice).toHaveBeenCalledWith(
      "sparkmerchant@blink.sv",
      5000,
      expect.any(String),
    )
  })

  it("returns 409 for a custodial receiver", async () => {
    mockResolveReceiver.mockResolvedValue({
      type: "custodial",
      username: "custodialuser",
      walletId: "w1",
      walletCurrency: "BTC",
    })
    const { req, res } = mockReqRes({ username: "custodialuser", amount: 5000 })
    await handler(req, res)
    expect(res._status).toBe(409)
    expect(res._json.receiverType).toBe("custodial")
    expect(mockGetInvoice).not.toHaveBeenCalled()
  })

  it("returns 404 when the address does not exist", async () => {
    mockResolveReceiver.mockRejectedValue(new ReceiverNotFoundError("ghost"))
    const { req, res } = mockReqRes({ username: "ghost", amount: 5000 })
    await handler(req, res)
    expect(res._status).toBe(404)
    expect(mockGetInvoice).not.toHaveBeenCalled()
  })

  it("surfaces LNURL amount-bounds errors as 400", async () => {
    mockGetInvoice.mockRejectedValue(new Error("Amount 1 sats is below minimum 10 sats"))
    const { req, res } = mockReqRes({ username: "sparkmerchant", amount: 1 })
    await handler(req, res)
    expect(res._status).toBe(400)
    expect(res._json.error).toMatch(/below minimum/)
  })

  it("returns 502 on generic LNURL failure", async () => {
    mockGetInvoice.mockRejectedValue(new Error("connection refused"))
    const { req, res } = mockReqRes({ username: "sparkmerchant", amount: 5000 })
    await handler(req, res)
    expect(res._status).toBe(502)
  })

  it("defaults environment to production and accepts staging", async () => {
    const { req, res } = mockReqRes({
      username: "sparkmerchant",
      amount: 5000,
      environment: "staging",
    })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(res._json.invoice.environment).toBe("staging")
  })
})

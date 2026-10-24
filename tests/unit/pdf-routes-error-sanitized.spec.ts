/** @jest-environment node */

/**
 * PDF routes must never echo renderer errors (or stacks) to the caller: a
 * renderer error can carry fetched or internal content.
 */

const SECRET = "internal-secret-content-from-renderer"

const mockRenderToBuffer = jest.fn()
jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: (...args: unknown[]) => mockRenderToBuffer(...args),
}))
jest.mock("../../lib/pdf/PaycodePDF", () => ({ PaycodeDocument: () => null }))
jest.mock("../../lib/pdf/TransactionReceiptPDF", () => ({
  TransactionReceiptDocument: () => null,
}))
jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_PUBLIC: {},
  RATE_LIMIT_WRITE: {},
}))
// receipt-pdf requires a POS session (blink-wip#1664)
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: {
    verifySession: (token?: string) =>
      token === "pos-session" ? { username: "alice" } : null,
  },
}))

import paycodePdfHandler from "../../pages/api/paycode/pdf"
import receiptPdfHandler from "../../pages/api/transaction/receipt-pdf"

type Handler = (req: never, res: never) => unknown

const call = async (handler: Handler, body: unknown) => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  await handler(
    {
      method: "POST",
      body,
      headers: {},
      query: {},
      cookies: { "auth-token": "pos-session" },
    } as never,
    res as never,
  )
  return res
}

describe("PDF routes sanitize 500 responses", () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
  const consoleLog = jest.spyOn(console, "log").mockImplementation(() => {})

  afterAll(() => {
    consoleError.mockRestore()
    consoleLog.mockRestore()
  })

  beforeEach(() => {
    mockRenderToBuffer.mockReset()
    mockRenderToBuffer.mockRejectedValue(new Error(SECRET))
  })

  it.each([
    [
      "paycode/pdf",
      paycodePdfHandler,
      {
        lightningAddress: "alice@blink.sv",
        // a real 1x1 PNG (the route checks the IHDR dimensions)
        qrDataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      },
      "Failed to generate Paycode PDF",
    ],
    [
      "transaction/receipt-pdf",
      receiptPdfHandler,
      { transaction: { id: "tx1", direction: "RECEIVE" } },
      "Failed to generate receipt PDF",
    ],
  ])("%s returns only a generic error", async (_name, handler, body, message) => {
    const res = await call(handler as Handler, body)

    expect(mockRenderToBuffer).toHaveBeenCalled()
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: message })
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
  })
})
